import type { Database } from 'bun:sqlite'
import type { KonvoyEvent, TurnContext } from '../types'
import type { Adapter } from '../adapters/types'
import { bumpBinding, recordEvent, recordTurn, upsertBinding } from '../store/queries'
import { onExit, track, untrack } from './children'

export interface TurnResult {
  final: string
  foreignId: string | null
  costUsd: number
  credits: number
  inputTokens: number
  outputTokens: number
  exitCode: number
  error: { message: string; kind: string } | null
  events: KonvoyEvent[]
}

export interface TurnDeps {
  db: Database
  adapter: Adapter
}

export interface TurnOptions {
  timeoutSec?: number
  onEvent?: (event: KonvoyEvent) => void
}

async function drain(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
    if (text.length > cap) text = text.slice(-cap)
  }
  return text
}

export async function runTurn(deps: TurnDeps, ctx: TurnContext, opts: TurnOptions = {}): Promise<TurnResult> {
  const { db, adapter } = deps
  const timeoutMs = (opts.timeoutSec ?? 900) * 1000
  const startedAt = Date.now()

  await adapter.prepare?.(ctx)
  const plan = adapter.turn(ctx)

  const result: TurnResult = {
    final: '',
    foreignId: ctx.binding?.foreignId ?? null,
    costUsd: 0,
    credits: 0,
    inputTokens: 0,
    outputTokens: 0,
    exitCode: 0,
    error: null,
    events: [],
  }

  let accumulated = ''
  let sawDone = false
  let seq = 0

  const parseLine = (line: string): KonvoyEvent[] => {
    try {
      return adapter.parse(line)
    } catch (error) {
      return [{ t: 'error', message: `${adapter.id} parser failed: ${String(error)}`, kind: 'crash' }]
    }
  }

  const proc = Bun.spawn(plan.cmd, {
    cwd: plan.cwd ?? ctx.cwd,
    env: { ...(plan.env ?? (process.env as Record<string, string>)), ...(ctx.lease ? { KONVOY_LEASE: ctx.lease } : {}) },
    stdin: plan.stdin ? new Response(plan.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  })
  track(proc)

  const stderrText = drain(proc.stderr as ReadableStream<Uint8Array>, 64 * 1024)

  const turnId = recordTurn(db, {
    sessionId: ctx.sessionId,
    agent: adapter.id,
    prompt: ctx.prompt,
    final: '',
    costUsd: 0,
    exitCode: -1,
    kind: ctx.kind ?? null,
  })

  const emit = (event: KonvoyEvent): void => {
    result.events.push(event)
    recordEvent(db, turnId, seq++, event.t, event)
    opts.onEvent?.(event)
    switch (event.t) {
      case 'session':
        result.foreignId = event.foreignId
        break
      case 'text':
        accumulated += event.text
        break
      case 'usage':
        result.credits += event.credits ?? 0
        result.costUsd += event.costUsd ?? 0
        result.inputTokens += event.inputTokens ?? 0
        result.outputTokens += event.outputTokens ?? 0
        break
      case 'error':
        result.error = { message: event.message, kind: event.kind }
        break
      case 'done':
        sawDone = true
        result.final = event.final
        break
    }
  }

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    db.query(
      `UPDATE turn SET final = $final, cost_usd = $cost, credits = $credits, input_tokens = $inTok,
         output_tokens = $outTok, exit_code = $exit, error = $error, ended_at = $ended WHERE id = $id`,
    ).run({
      id: turnId,
      final: result.final,
      cost: result.costUsd,
      credits: result.credits,
      inTok: result.inputTokens,
      outTok: result.outputTokens,
      exit: result.exitCode,
      error: result.error?.message ?? null,
      ended: Date.now(),
    })
    upsertBinding(db, {
      sessionId: ctx.sessionId,
      agent: adapter.id,
      foreignId: result.foreignId,
      effort: ctx.effort,
      permission: ctx.permission,
      model: ctx.model ?? null,
    })
    bumpBinding(db, ctx.sessionId, adapter.id, result.costUsd, result.credits)
  }

  // every path below must reach finish(): an onEvent callback that throws, a parser crash a
  // wrapper missed, or a signal — otherwise the turn row stays at its INSERT placeholder and
  // usage counts it as a free turn.
  const releaseExitHandler = onExit(() => {
    if (!result.error) result.error = { message: 'konvoy was interrupted', kind: 'crash' }
    finish()
  })

  const decoder = new TextDecoder()
  let buffer = ''
  try {
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) for (const event of parseLine(line)) emit(event)
      }
      if (buffer.trim()) for (const event of parseLine(buffer)) emit(event)
    } finally {
      if (proc.exitCode === null) proc.kill()
    }

    result.exitCode = await proc.exited

    if (!sawDone) result.final = accumulated
    if (!result.foreignId && adapter.resolveForeignId) {
      result.foreignId = await adapter.resolveForeignId(ctx, startedAt)
    }

    if (result.exitCode !== 0 && !result.error) {
      const stderr = await stderrText
      const timedOut = Date.now() - startedAt >= timeoutMs
      result.error = {
        message: timedOut ? `turn timed out after ${opts.timeoutSec ?? 900}s` : stderr.trim() || `exit ${result.exitCode}`,
        kind: 'crash',
      }
    }

    const failed = result.exitCode !== 0 || (result.error !== null && result.final.trim() === '')
    if (!failed) result.error = null
  } catch (error) {
    result.error = result.error ?? { message: String(error), kind: 'crash' }
    if (result.exitCode === 0) {
      result.exitCode = proc.exitCode ?? (await proc.exited.catch(() => -1))
    }
  } finally {
    releaseExitHandler()
    untrack(proc)
    finish()
  }

  return result
}
