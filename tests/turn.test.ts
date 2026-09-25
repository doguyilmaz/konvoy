import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, getBinding, upsertBinding } from '../src/store/queries'
import { runTurn, drain } from '../src/core/turn'
import { liveCount } from '../src/core/children'
import { claudeAdapter } from '../src/adapters/claude'
import { kiroAdapter } from '../src/adapters/kiro'
import type { Adapter } from '../src/adapters/types'
import type { TurnContext } from '../src/types'

function fakeAdapter(lines: unknown[], over: Partial<Adapter> = {}): Adapter {
  return {
    ...claudeAdapter,
    turn: () => ({ cmd: ['bun', 'tests/fixtures/fake-agent.ts', ...lines.map((l) => JSON.stringify(l))] }),
    ...over,
  }
}

const ctx = (sessionId: string, over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId,
  slug: 'demo',
  cwd: process.cwd(),
  sessionDir: '/tmp/konvoy-demo',
  prompt: 'do it',
  binding: null,
  effort: 'high',
  permission: 'edit',
  ...over,
})

test('draining stderr never leaves a lone surrogate at the cap boundary', async () => {
  const cap = 64 * 1024
  const highSurrogate = '\uD83D'
  const lowSurrogate = '\uDE00'
  // trailing length must be exactly cap - 1 so slice(-cap) cuts precisely between the
  // two halves of the surrogate pair, regardless of how much precedes it
  const trailing = 'yz' + 'z'.repeat(cap - 1 - 2)
  const full = highSurrogate + lowSurrogate + trailing
  expect(full.length).toBe(cap + 1)

  const bytes = new TextEncoder().encode(full)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

  const drained = await drain(stream, cap)
  const firstCode = drained.charCodeAt(0)
  expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false)
  expect(drained.startsWith('yz')).toBe(true)
})

test('a turn returns the final message and captures the foreign id', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'system', subtype: 'init', session_id: 'sess-99' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    { type: 'result', subtype: 'success', result: 'done here', total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 4 } },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.final).toBe('done here')
  expect(r.foreignId).toBe('sess-99')
  expect(r.costUsd).toBeCloseTo(0.5)
  expect(r.inputTokens).toBe(3)
  expect(r.exitCode).toBe(0)
  expect(r.error).toBe(null)
})

test('the binding is written from the stream', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'system', subtype: 'init', session_id: 'sess-77' },
    { type: 'result', subtype: 'success', result: 'ok' },
  ])
  await runTurn({ db, adapter }, ctx(s.id))
  expect(getBinding(db, s.id, 'claude')?.foreignId).toBe('sess-77')
  expect(getBinding(db, s.id, 'claude')?.turns).toBe(1)
})

test('a foreign id carrying a terminal escape sequence is stored and printed without the escape bytes', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const hostile = 'sess\x1b]0;pwned\x07-1'
  const adapter = fakeAdapter([
    { type: 'system', subtype: 'init', session_id: hostile },
    { type: 'result', subtype: 'success', result: 'ok' },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  // the whole OSC sequence goes, not only its ESC and BEL - "]0;pwned" is the payload, not the id
  expect(r.foreignId).toBe('sess-1')
  expect(r.foreignId).not.toContain('\x1b')
  expect(r.foreignId).not.toContain('\x07')

  const stored = getBinding(db, s.id, 'claude')?.foreignId ?? null
  expect(stored).toBe('sess-1')

  const { formatRoster } = await import('../src/format')
  const printed = formatRoster([
    { agent: 'claude', status: 'bound', model: '', effort: 'high', foreignId: stored, turns: 1, costUsd: 0, credits: 0 },
  ])
  expect(printed).not.toContain('\x1b')
  expect(printed).not.toContain('\x07')
})

test('a stream with no terminal event synthesises the final message from its text', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'part one ' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'part two' }] } },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.final).toBe('part one part two')
})

test('an error event is surfaced and classified', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([{ type: 'result', is_error: true, result: 'Invalid API key' }])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.error?.kind).toBe('auth')
})

test('a parser that throws is contained and the turn still completes', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter: Adapter = {
    ...fakeAdapter([{ type: 'result', subtype: 'success', result: 'survived' }]),
    parse: (line: string) => {
      if (line.includes('result')) throw new Error('boom')
      return []
    },
    // the stateful reading a turn prefers; left inherited, it would parse around the throw
    parser: undefined,
  }
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.exitCode).toBe(0)
  expect(r.events.some((e) => e.t === 'error')).toBe(true)
})

test('a child is tracked while it runs and untracked once the turn returns', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'result', subtype: 'success', result: 'ok' },
  ])

  let whileRunning = -1
  await runTurn({ db, adapter }, ctx(s.id), {
    onEvent: () => {
      if (whileRunning < 0) whileRunning = liveCount()
    },
  })

  expect(whileRunning).toBe(1)
  expect(liveCount()).toBe(0)
})

test('a caller callback that throws still leaves a complete turn row', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'result', subtype: 'success', result: 'done' },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id), {
    onEvent: () => {
      throw new Error('boom')
    },
  })
  expect(r.error?.kind).toBe('crash')
  expect(liveCount()).toBe(0)
  const row = db.query('SELECT exit_code, ended_at, started_at FROM turn WHERE session_id = $s').get({ s: s.id }) as
    | Record<string, number>
    | null
  expect(row?.exit_code).not.toBe(-1)
  expect(row?.ended_at).toBeGreaterThan(0)
})

test('a turn that exceeds its timeout is killed and reported', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => ({
      cmd: ['bun', 'tests/fixtures/fake-agent.ts', JSON.stringify({ type: 'assistant', message: { content: [] } })],
      env: { ...process.env, FAKE_AGENT_DELAY_MS: '3000' } as Record<string, string>,
    }),
  }
  const r = await runTurn({ db, adapter }, ctx(s.id), { timeoutSec: 1 })
  expect(r.error?.kind).toBe('timeout')
  expect(r.error?.message).toContain('timed out')
})

test('an interruption is classified as interrupted, not a generic crash', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => ({
      cmd: [
        'bun',
        'tests/fixtures/fake-agent.ts',
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
      ],
      env: { ...process.env, FAKE_AGENT_DELAY_MS: '300' } as Record<string, string>,
    }),
  }

  // process.exit is stubbed so the real SIGINT listener installed by children.ts can run to
  // completion (kill the child, run finish()) without ending the test process; process.emit
  // drives that same real listener, not a reimplementation of it.
  const originalExit = process.exit
  process.exit = (() => undefined as never) as typeof process.exit
  let fired = false
  try {
    const r = await runTurn({ db, adapter }, ctx(s.id), {
      onEvent: () => {
        if (!fired) {
          fired = true
          process.emit('SIGINT' as never)
        }
      },
    })
    expect(r.error?.kind).toBe('interrupted')
    expect(r.error?.message).toContain('SIGINT')
  } finally {
    process.exit = originalExit
  }
  const row = db.query('SELECT error_kind FROM turn WHERE session_id = $s').get({ s: s.id }) as
    | Record<string, unknown>
    | null
  expect(row?.error_kind).toBe('interrupted')
})

test('an informational error on a successful run does not fail the turn', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'result', is_error: true, result: 'Skill descriptions were shortened' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'still fine' }] } },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.exitCode).toBe(0)
  expect(r.final).toBe('still fine')
  expect(r.error).toBe(null)
})

test('a rate-limit error survives a turn that streamed text and exited 0', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } },
    { type: 'result', is_error: true, result: "You've hit your session limit · resets 12:40am" },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.exitCode).toBe(0)
  expect(r.final).toBe('partial answer')
  expect(r.error?.kind).toBe('rate')
  expect(r.error?.message).toContain('session limit')

  const row = db.query('SELECT error_kind, exit_code, final FROM turn WHERE session_id = $s').get({ s: s.id }) as
    | Record<string, unknown>
    | null
  expect(row?.error_kind).toBe('rate')
  expect(row?.exit_code).toBe(0)
  expect(row?.final).toBe('partial answer')
})

test('an auth error survives a turn that streamed text and exited 0', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
    { type: 'result', is_error: true, result: 'Invalid API key provided' },
  ])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.exitCode).toBe(0)
  expect(r.final).toBe('partial')
  expect(r.error?.kind).toBe('auth')
})

test('a crash-kind error is still discarded once the turn produced text, as today', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter: Adapter = {
    ...fakeAdapter([{ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }]),
    parse: (line: string) => [...claudeAdapter.parse(line), { t: 'error', message: 'transient failure', kind: 'crash' }],
  }
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.exitCode).toBe(0)
  expect(r.final).toBe('ok')
  expect(r.error).toBe(null)
})

test('a child that traps SIGTERM is still killed, within the grace period', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => ({
      cmd: ['bun', 'tests/fixtures/fake-agent.ts', JSON.stringify({ type: 'assistant', message: { content: [] } })],
      env: {
        ...process.env,
        FAKE_AGENT_DELAY_MS: '5000',
        FAKE_AGENT_TRAP_SIGTERM: '1',
      } as Record<string, string>,
    }),
  }
  const startedAt = Date.now()
  const r = await runTurn({ db, adapter }, ctx(s.id), { timeoutSec: 1, killGraceMs: 300 })
  const elapsedMs = Date.now() - startedAt
  expect(elapsedMs).toBeLessThan(3000)
  expect(r.error?.kind).toBe('timeout')
  expect(liveCount()).toBe(0)
})

test('finish writes the model onto the turn row', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'result', subtype: 'success', result: 'ok' },
  ])
  await runTurn({ db, adapter }, ctx(s.id, { model: 'opus-4' }))
  const row = db.query('SELECT model FROM turn WHERE session_id = $s').get({ s: s.id }) as
    | Record<string, unknown>
    | null
  expect(row?.model).toBe('opus-4')
})

test('every event is streamed to the callback', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'result', subtype: 'success', result: 'bye' },
  ])
  const seen: string[] = []
  await runTurn({ db, adapter }, ctx(s.id), { onEvent: (e) => seen.push(e.t) })
  expect(seen).toContain('text')
  expect(seen).toContain('done')
})

// Adapters no longer invent text for an error that carries none, so turn.ts reads stderr on a
// non-zero exit. The remaining case: exit 0, no output, an error event with no words - nothing
// anywhere says what went wrong. The user must still get a sentence, not an empty quote.
test('an error with no words that survives stream and stderr is given a stated message', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([{ type: 'result', subtype: 'error_during_execution', is_error: true }])
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.exitCode).toBe(0)
  expect(r.final).toBe('')
  expect(r.error?.kind).toBe('unknown')
  expect(r.error?.message).toMatch(/claude exited 0 and reported an error without a message/)
})

// An adapter that sets env must extend the child's environment, not replace it: with only its
// own variables the child has no PATH, the spawn throws before any turn row is written, and
// the failure names neither the adapter nor the variable.
test('an adapter env extends the process environment instead of replacing it', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([{ type: 'result', subtype: 'success', result: 'ran' }], {
    turn: () => ({
      cmd: ['bun', 'tests/fixtures/fake-agent.ts', JSON.stringify({ type: 'result', subtype: 'success', result: 'ran' })],
      env: { MY_ONLY_VAR: '1' },
    }),
  })
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.final).toBe('ran')
  expect(r.exitCode).toBe(0)
})

test('a kiro turn whose finalText is truncated keeps the full streamed answer', async () => {
  const { kiroAdapter } = await import('../src/adapters/kiro')
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'kiro' })
  const adapter: Adapter = {
    ...kiroAdapter,
    // the profile kiro's prepare() writes would land in this repository; the parse is what is tested
    prepare: undefined,
    turn: () => ({
      cmd: [
        'bun', 'tests/fixtures/fake-agent.ts',
        JSON.stringify({ type: 'metadata', data: { sessionId: 'k-1' } }),
        JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'k-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'long ans' } } } }),
        JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'k-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wer' } } } }),
        JSON.stringify({ type: 'runFinished', data: { sessionId: 'k-1', status: 'success', finalText: 'long a', finalTextTruncated: true } }),
      ],
    }),
  }
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.final).toBe('long answer')
  expect(r.error).toBeNull()
})

// Measured before the fix: the agent exited at ~50 ms, the grandchild held the pipe for 3 s,
// and runTurn returned after the grandchild - 4,071 ms against a 1.2 s budget - reporting
// exit 0 and no error, with the session lock held the whole time. The SIGKILL escalation was
// guarded on the child still being alive; the drain loop ended only when every holder of the
// pipe closed it. The turn must end on konvoy's clock: once the child is gone, a short grace,
// then the read is cancelled.
test('a descendant holding stdout after the agent exits does not extend the turn past the grace', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([], { turn: () => ({ cmd: ['bun', 'tests/fixtures/leaky-agent.ts'] }) })
  const t0 = Date.now()
  const r = await runTurn({ db, adapter }, ctx(s.id), { timeoutSec: 1, killGraceMs: 200, drainGraceMs: 300 })
  expect(Date.now() - t0).toBeLessThan(1500)
  expect(r.final).toBe('done')
  expect(r.exitCode).toBe(0)
  expect(r.error).toBeNull()
})

// Spec §15: "auth errors detected from the stream; binding marked auth_required". The status
// column only ever read bound or unbound, so the roster could not say which agent needs a
// login. A later successful turn clears it back to bound.
test('an auth failure marks the binding auth_required, and the next successful turn clears it', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  await runTurn({ db, adapter: fakeAdapter([{ type: 'system', subtype: 'init', session_id: 'sess-a' }, { type: 'result', is_error: true, result: 'Invalid API key' }]) }, ctx(s.id))
  expect(getBinding(db, s.id, 'claude')?.status).toBe('auth_required')
  await runTurn({ db, adapter: fakeAdapter([{ type: 'result', subtype: 'success', result: 'back' }]) }, ctx(s.id))
  expect(getBinding(db, s.id, 'claude')?.status).toBe('bound')
})

// Detection pre-empts a missing binary, but a binary that exists and cannot start (no execute
// bit, a bad interpreter) threw out of Bun.spawn before the turn row was written, so the
// failure left no trace. The row is recorded first now; the failed start is its ending.
test('a binary that exists but cannot start still leaves a turn row with the error', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const file = (await Bun.$`mktemp`.text()).trim()
  await Bun.write(file, '#!/bin/sh\necho never\n')
  await Bun.$`chmod 644 ${file}`.quiet()
  try {
    const r = await runTurn({ db, adapter: fakeAdapter([], { turn: () => ({ cmd: [file] }) }) }, ctx(s.id))
    expect(r.exitCode).toBe(127)
    expect(r.error?.kind).toBe('crash')
    const row = db.query('SELECT exit_code, error FROM turn WHERE session_id = $s').get({ s: s.id }) as { exit_code: number; error: string | null }
    expect(row.exit_code).toBe(127)
    expect(row.error).toContain('could not start')
  } finally {
    await Bun.$`rm -f ${file}`.quiet()
  }
})

// The reachability test for adapter warnings: turn.ts reads stderr only when the turn FAILED,
// and kiro's "failed to set agent" warning comes with exit 0, so a warning that is parsed but
// never read would be the same defect as every other capability this project built twice.
test('a warning a CLI writes to stderr on a successful turn reaches the result', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: process.cwd(), lead: 'kiro' })
  const seen: string[] = []
  const adapter: Adapter = {
    ...kiroAdapter,
    // the profile kiro's prepare() writes would land in this repository; the parse is what is tested
    prepare: undefined,
    turn: () => ({
      cmd: [
        'bun',
        'tests/fixtures/fake-agent.ts',
        JSON.stringify({ type: 'runFinished', data: { status: 'success', finalText: 'done' } }),
      ],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), FAKE_AGENT_STDERR: "[warn] failed to set agent 'konvoy-minimal': Internal error" },
    }),
    warnings: (stderr) => {
      seen.push(stderr)
      return kiroAdapter.warnings?.(stderr) ?? []
    },
  }

  const result = await runTurn({ db, adapter }, ctx(s.id, { prompt: 'go' }))
  expect(result.exitCode).toBe(0)
  expect(result.error).toBe(null)
  expect(seen.join('')).toContain('failed to set agent')
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain('not the minimal harness')
})

// The REPL's Esc: the agent is stopped and the turn recorded as interrupted, while konvoy itself
// carries on - which a signal to konvoy's own process could never offer.
test('an aborted turn stops the agent, keeps what it said, and is recorded as interrupted', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => ({
      cmd: [
        'bun', 'tests/fixtures/fake-agent.ts',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' never sent' }] } }),
      ],
      env: { ...(process.env as Record<string, string>), FAKE_AGENT_DELAY_MS: '400' },
    }),
  }
  const controller = new AbortController()
  const started = Date.now()
  const run = runTurn({ db, adapter }, ctx(s.id), { signal: controller.signal, onEvent: (e) => e.t === 'text' && controller.abort() })
  const r = await run
  expect(Date.now() - started).toBeLessThan(3000)
  expect(r.error).toEqual({ message: 'interrupted', kind: 'interrupted' })
  expect(r.exitCode).not.toBe(0)
  expect(r.final).toBe('partial answer')
  const row = db.query('SELECT error_kind, final FROM turn').get() as { error_kind: string; final: string }
  expect(row).toEqual({ error_kind: 'interrupted', final: 'partial answer' })
})

test('a signal already aborted stops the turn before it gets going', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([{ type: 'result', subtype: 'success', result: 'late' }], {
    turn: () => ({ cmd: ['bun', 'tests/fixtures/fake-agent.ts', JSON.stringify({ type: 'result', subtype: 'success', result: 'late' })], env: { ...(process.env as Record<string, string>), FAKE_AGENT_DELAY_MS: '2000' } }),
  })
  const controller = new AbortController()
  controller.abort()
  const r = await runTurn({ db, adapter }, ctx(s.id), { signal: controller.signal })
  expect(r.error?.kind).toBe('interrupted')
})

// A streamed claude answer is hundreds of deltas; a stored row per delta is a write per token.
test('consecutive text is stored as one event, while the caller still sees every delta', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  const adapter = fakeAdapter([
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
    delta('one '),
    delta('two '),
    delta('three'),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'one two three' }] } },
    { type: 'result', subtype: 'success', result: 'one two three' },
  ])
  const seen: string[] = []
  const r = await runTurn({ db, adapter }, ctx(s.id), { onEvent: (e) => e.t === 'text' && seen.push(e.text) })
  expect(seen).toEqual(['one ', 'two ', 'three'])
  expect(r.final).toBe('one two three')
  const rows = db.query("SELECT payload FROM event WHERE type = 'text'").all() as { payload: string }[]
  expect(rows.map((row) => JSON.parse(row.payload).text)).toEqual(['one two three'])
})
