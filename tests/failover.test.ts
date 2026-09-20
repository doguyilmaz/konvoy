import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession } from '../src/store/queries'
import { configSchema } from '../src/config/schema'
import { claudeAdapter } from '../src/adapters/claude'
import type { Adapter } from '../src/adapters/types'
import type { AgentId } from '../src/types'
import { send } from '../src/core/session'

const ok = (text: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: `sess-${text}` }),
  JSON.stringify({ type: 'result', subtype: 'success', result: text }),
]
const fails = (message: string) => [JSON.stringify({ type: 'result', is_error: true, result: message })]

/** one adapter per agent, each emitting the lines it is scripted to emit */
function scripted(script: Partial<Record<AgentId, string[]>>, calls: AgentId[]): (a: AgentId) => Adapter {
  return (agent) => ({
    ...claudeAdapter,
    id: agent,
    turn: () => {
      calls.push(agent)
      return { cmd: ['bun', 'tests/fixtures/fake-agent.ts', ...(script[agent] ?? ok(agent))], cwd: process.cwd() }
    },
  })
}

const seed = () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: process.cwd(), lead: 'codex' })
  return { db, s }
}
const cfg = (over: Record<string, unknown> = {}) =>
  configSchema.parse({ failover: { chain: ['codex', 'claude', 'kiro'] }, ...over })

test('a rate limit moves to the next agent at once', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const r = await send(
      { db, cfg: cfg(), adapterFor: scripted({ codex: fails("You've hit your weekly limit · resets 7am") }, calls) },
      s, 'codex', 'hello',
    )
    expect(r.final).toBe('claude')
    expect(calls).toEqual(['codex', 'claude'])
  } finally {
    err.mockRestore()
  }
})

test('an auth failure moves to the next agent at once', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send(
      { db, cfg: cfg(), adapterFor: scripted({ codex: fails('Not signed in. Please run codex login.') }, calls) },
      s, 'codex', 'hello',
    )
    expect(calls).toEqual(['codex', 'claude'])
  } finally {
    err.mockRestore()
  }
})

test('an upstream failure is retried on the same agent before the chain moves', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send(
      { db, cfg: cfg({ failover: { chain: ['codex', 'claude'], upstreamRetries: 2 } }),
        adapterFor: scripted({ codex: fails('503 Service Unavailable') }, calls) },
      s, 'codex', 'hello',
    )
    // the original attempt, two retries, then the successor
    expect(calls).toEqual(['codex', 'codex', 'codex', 'claude'])
  } finally {
    err.mockRestore()
  }
})

test('a crash does not move to the next agent, because the fault travels with the work', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const r = await send(
    { db, cfg: cfg(), adapterFor: scripted({ codex: fails('TypeError: cannot read property of undefined') }, calls) },
    s, 'codex', 'hello',
  )
  expect(calls).toEqual(['codex'])
  expect(r.error?.kind).toBe('unknown')
})

// The brief's own crash test drives a message classifyError falls through to 'unknown', not
// the literal 'crash' kind turn.ts assigns to a bare nonzero exit. Both must stay put, so this
// exercises the other one directly — otherwise "the chain also moves on crash" is a mutation
// the suite above cannot see.
test('a bare nonzero exit (kind "crash") does not move to the next agent either', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const adapterFor = (a: AgentId): Adapter => ({
    ...claudeAdapter,
    id: a,
    turn: () => {
      calls.push(a)
      return {
        cmd: ['bun', 'tests/fixtures/fake-agent.ts'],
        env: { ...process.env, FAKE_AGENT_EXIT: '1' } as Record<string, string>,
        cwd: process.cwd(),
      }
    },
  })
  const r = await send({ db, cfg: cfg(), adapterFor }, s, 'codex', 'hello')
  expect(calls).toEqual(['codex'])
  expect(r.error?.kind).toBe('crash')
})

test('the user is told which agent was blocked, what it said, and who took over', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[] = []
  try {
    await send(
      { db, cfg: cfg(), adapterFor: scripted({ codex: fails("You've hit your weekly limit · resets 7am") }, calls) },
      s, 'codex', 'hello',
    )
    lines = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
  const notice = lines.find((l) => l.includes('codex') && l.includes('claude'))
  expect(notice).toBeDefined()
  // the reset time travels inside the message, so quoting it is what makes the line useful
  expect(notice).toContain('resets 7am')
})

test('the replacement turn points at the turn it replaced', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send(
      { db, cfg: cfg(), adapterFor: scripted({ codex: fails("You've hit your weekly limit") }, calls) },
      s, 'codex', 'hello',
    )
  } finally {
    err.mockRestore()
  }
  const rows = db
    .query('SELECT agent, id, parent_turn_id FROM turn WHERE session_id = $id ORDER BY started_at')
    .all({ id: s.id }) as { agent: string; id: string; parent_turn_id: string | null }[]
  expect(rows[0]!.agent).toBe('codex')
  expect(rows[1]!.agent).toBe('claude')
  expect(rows[1]!.parent_turn_id).toBe(rows[0]!.id)
})

test('with no chain configured a block surfaces instead of moving', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const r = await send(
    { db, cfg: configSchema.parse({}), adapterFor: scripted({ codex: fails("You've hit your weekly limit") }, calls) },
    s, 'codex', 'hello',
  )
  expect(calls).toEqual(['codex'])
  expect(r.error?.kind).toBe('rate')
})

test('a chain member the user never set up is skipped out loud, not silently', async () => {
  const { db, s } = seed()
  const calls: AgentId[] = []
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[] = []
  try {
    // claude sits in the middle of the chain but is disabled, so kiro must take the handoff
    const r = await send(
      {
        db,
        cfg: cfg({ agents: { claude: { enabled: false } } }),
        adapterFor: scripted({ codex: fails("You've hit your weekly limit") }, calls),
      },
      s, 'codex', 'hello',
    )
    lines = err.mock.calls.map((c) => String(c[0]))
    expect(calls).toEqual(['codex', 'kiro'])
    expect(r.final).toBe('kiro')
  } finally {
    err.mockRestore()
  }
  // a three-agent chain that quietly becomes a two-agent chain is the user not being told
  const skipped = lines.find((l) => l.includes('claude') && !l.includes('kiro'))
  expect(skipped).toBeDefined()
  expect(skipped!.toLowerCase()).toMatch(/skip|disabled|not installed/)
})
