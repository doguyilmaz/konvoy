import type { Database } from 'bun:sqlite'
import type { KonvoyEvent, TurnContext } from '../types'
import type { Adapter } from '../adapters/types'
import { bumpBinding, recordEvent, recordTurn, upsertBinding } from '../store/queries'
import { onExit, track, untrack, DEFAULT_KILL_GRACE_MS, escalateKill } from './children'

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
  /** things the CLI said on stderr that the turn survived but the user must know about */
  warnings: string[]
}

export interface TurnDeps {
  db: Database
  adapter: Adapter
}

export interface TurnOptions {
  timeoutSec?: number
  onEvent?: (event: KonvoyEvent) => void
  /** grace period after the timeout's SIGTERM before konvoy escalates to SIGKILL */
  killGraceMs?: number
  drainGraceMs?: number
  /** the first blocked turn this one replaces, when a failover chain moved to a new agent */
  parentTurnId?: string | null
}

// how long a pipe may stay open after the child is gone before the read is cut off
const DEFAULT_DRAIN_GRACE_MS = 500

// `until` ends the read on the caller's clock: a descendant that inherited the pipe would
// otherwise keep it open, and with it the turn, for as long as it lives
export async function drain(stream: ReadableStream<Uint8Array>, cap: number, until?: Promise<unknown>): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  void until?.then(() => reader.cancel().catch(() => undefined))
  let text = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.length > cap) {
      text = text.slice(-cap)
      const lead = text.charCodeAt(0)
      if (lead >= 0xdc00 && lead <= 0xdfff) text = text.slice(1)
    }
  }
  return text
}

export async function runTurn(deps: TurnDeps, ctx: TurnContext, opts: TurnOptions = {}): Promise<TurnResult> {
  const { db, adapter } = deps
  const timeoutMs = (opts.timeoutSec ?? 900) * 1000

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
    warnings: [],
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

  const turnId = recordTurn(db, {
    sessionId: ctx.sessionId,
    agent: adapter.id,
    prompt: ctx.prompt,
    final: '',
    costUsd: 0,
    exitCode: -1,
    kind: ctx.kind ?? null,
    parentTurnId: opts.parentTurnId ?? null,
  })

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    db.query(
      `UPDATE turn SET final = $final, cost_usd = $cost, credits = $credits, input_tokens = $inTok,
         output_tokens = $outTok, exit_code = $exit, error = $error, error_kind = $errorKind,
         ended_at = $ended, model = $model WHERE id = $id`,
    ).run({
      id: turnId,
      final: result.final,
      cost: result.costUsd,
      credits: result.credits,
      inTok: result.inputTokens,
      outTok: result.outputTokens,
      exit: result.exitCode,
      error: result.error?.message ?? null,
      errorKind: result.error?.kind ?? null,
      ended: Date.now(),
      model: ctx.model ?? null,
    })
    upsertBinding(db, {
      sessionId: ctx.sessionId,
      agent: adapter.id,
      foreignId: result.foreignId,
      effort: ctx.effort,
      permission: ctx.permission,
      model: ctx.model ?? null,
      status: result.error?.kind === 'auth' ? 'auth_required' : undefined,
    })
    bumpBinding(db, ctx.sessionId, adapter.id, result.costUsd, result.credits)
  }

  const spawnedAt = Date.now()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(plan.cmd, {
    cwd: plan.cwd ?? ctx.cwd,
    env: { ...(process.env as Record<string, string>), ...(plan.env ?? {}), ...(ctx.lease ? { KONVOY_LEASE: ctx.lease } : {}) },
    stdin: plan.stdin ? new Response(plan.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  })
  } catch (error) {
    // the binary exists but cannot start - no execute bit, a bad interpreter: detection cannot
    // see it, and the turn row recorded above is what keeps the failure from leaving no trace
    result.exitCode = 127
    result.error = { message: `could not start ${plan.cmd[0]}: ${error instanceof Error ? error.message : String(error)}`, kind: 'crash' }
    finish()
    return result
  }
  track(proc)

  const cancelEscalation = escalateKill(proc, timeoutMs + (opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS))

  // once the child has exited, whoever still holds its pipes is something it left behind;
  // it gets this long to flush, then both reads end
  const afterExit = proc.exited.then(() => Bun.sleep(opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS))
  const stderrText = drain(proc.stderr as ReadableStream<Uint8Array>, 64 * 1024, afterExit)


  // exit_code -1 means konvoy itself died before it could record the turn. Every ordinary
  // ending, including an interruption, replaces it - so a surviving -1 is a real signal, not
  // a default. Failure is decided by the error field, not by the exit code alone: an interrupted turn
  // carries 130 or 143 and a message, and a codex turn can exit 0 with an informational error.

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


  // every path below must reach finish(): an onEvent callback that throws, a parser crash a
  // wrapper missed, or a signal - otherwise the turn row stays at its INSERT placeholder and
  // usage counts it as a free turn.
  const releaseExitHandler = onExit((signal) => {
    if (!result.error) result.error = { message: `konvoy was interrupted by ${signal}`, kind: 'interrupted' }
    if (result.exitCode === 0) result.exitCode = signal === 'SIGINT' ? 130 : 143
    finish()
  })

  const decoder = new TextDecoder()
  let buffer = ''
  try {
    try {
      const stdout = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      void afterExit.then(() => stdout.cancel().catch(() => undefined))
      while (true) {
        const { value, done } = await stdout.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) for (const event of parseLine(line)) emit(event)
      }
      if (buffer.trim()) for (const event of parseLine(buffer)) emit(event)
    } finally {
      if (proc.exitCode === null) proc.kill()
    }

    result.exitCode = await proc.exited

    // A CLI can succeed and still have done something other than what konvoy asked: kiro warns
    // on stderr and carries on when it cannot load an agent profile, so a turn konvoy believes
    // is running a minimal harness quietly runs the user's whole setup. stderr below is read
    // only when the turn FAILED, which is exactly the case this misses.
    if (adapter.warnings) {
      for (const warning of adapter.warnings(await stderrText)) result.warnings.push(warning)
    }

    if (!sawDone) result.final = accumulated

    // an error event that carries no words (claude's is_error result on a dead session id)
    // must not stand in for stderr, which is where that CLI puts the reason
    if (result.exitCode !== 0 && !result.error?.message.trim()) {
      const stderr = await stderrText
      const timedOut = Date.now() - spawnedAt >= timeoutMs
      result.error = {
        message: timedOut ? `turn timed out after ${opts.timeoutSec ?? 900}s` : stderr.trim() || `exit ${result.exitCode}`,
        kind: timedOut ? 'timeout' : 'crash',
      }
    }

    // The exit code says whether the turn produced its output; the error says whether the
    // agent is now blocked. auth and rate never mean "just informational" - the agent cannot
    // work until something changes - so they survive even a turn that answered and exited 0.
    // crash and unknown keep the old behaviour: discarded once there was any output at all.
    // an error that stayed wordless through the stream and stderr - say so, rather than show
    // the user an empty quote
    if (result.error && !result.error.message.trim()) {
      result.error.message = `${adapter.id} exited ${result.exitCode} and reported an error without a message`
    }
    const failed = result.exitCode !== 0 || (result.error !== null && result.final.trim() === '')
    const blocking = result.error?.kind === 'auth' || result.error?.kind === 'rate'
    if (!failed && !blocking) result.error = null
  } catch (error) {
    result.error = result.error ?? { message: String(error), kind: 'crash' }
    if (result.exitCode === 0) {
      result.exitCode = proc.exitCode ?? (await proc.exited.catch(() => -1))
    }
  } finally {
    cancelEscalation()
    releaseExitHandler()
    untrack(proc)
    finish()
  }

  return result
}
