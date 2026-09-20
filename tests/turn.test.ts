import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, getBinding, upsertBinding } from '../src/store/queries'
import { runTurn, drain } from '../src/core/turn'
import { liveCount } from '../src/core/children'
import { claudeAdapter } from '../src/adapters/claude'
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
  expect(r.foreignId).toBe('sess]0;pwned-1')
  expect(r.foreignId).not.toContain('\x1b')
  expect(r.foreignId).not.toContain('\x07')

  const stored = getBinding(db, s.id, 'claude')?.foreignId ?? null
  expect(stored).toBe('sess]0;pwned-1')

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

test('resolveForeignId is the fallback when the stream carries no session id', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([{ type: 'result', subtype: 'success', result: 'ok' }], {
    resolveForeignId: async () => 'recovered-id',
  })
  const r = await runTurn({ db, adapter }, ctx(s.id))
  expect(r.foreignId).toBe('recovered-id')
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
