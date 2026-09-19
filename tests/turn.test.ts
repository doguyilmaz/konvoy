import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, getBinding, upsertBinding } from '../src/store/queries'
import { runTurn } from '../src/core/turn'
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

test('no child process is left behind once a turn returns', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  const adapter = fakeAdapter([{ type: 'result', subtype: 'success', result: 'ok' }])
  await runTurn({ db, adapter }, ctx(s.id))
  expect(liveCount()).toBe(0)
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
  expect(r.error?.kind).toBe('crash')
  expect(r.error?.message).toContain('timed out')
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
