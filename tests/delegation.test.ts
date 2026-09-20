import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { claudeAdapter } from '../src/adapters/claude'
import { withPrelude, type Adapter } from '../src/adapters/types'
import type { AgentId } from '../src/types'
import { newSession, send } from '../src/core/session'

const ok = (text: string) => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: `sess-${text}` }),
  JSON.stringify({ type: 'result', subtype: 'success', result: text }),
]
const handsOff = (to: string, task: string) =>
  ok(`done.\n\n<<<konvoy\nto: ${to}\ntask: ${task}\nopen:\n- the device clock drifts\n>>>`)

const cfg = (over: Record<string, unknown> = {}) =>
  configSchema.parse({ delegation: { enabled: true }, roles: { reviewer: 'claude' }, ...over })

function harness(script: Partial<Record<AgentId, string[]>>) {
  const calls: AgentId[] = []
  const seen: Record<string, string> = {}
  const adapterFor = (agent: AgentId): Adapter => ({
    ...claudeAdapter,
    id: agent,
    turn: (ctx) => {
      calls.push(agent)
      seen[agent] = withPrelude(ctx)
      return { cmd: ['bun', 'tests/fixtures/fake-agent.ts', ...(script[agent] ?? ok(agent))], cwd: process.cwd() }
    },
  })
  return { calls, seen, adapterFor }
}

test('an envelope naming a role runs that role next', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('reviewer', 'check the refresh path') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
  } finally {
    err.mockRestore()
  }
  expect(h.calls).toEqual(['codex', 'claude'])
})

test('the recipient receives the sender own words, not a derived summary', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('reviewer', 'check the refresh path') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
  } finally {
    err.mockRestore()
  }
  expect(h.seen.claude).toContain('check the refresh path')
  expect(h.seen.claude).toContain('the device clock drifts')
  // the cooperative path must not claim the intent is missing — the sender stated it
  expect(h.seen.claude!.toLowerCase()).not.toContain('was not recorded')
})

test('an envelope naming an agent directly runs that agent', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('kiro', 'take it from here') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
  } finally {
    err.mockRestore()
  }
  expect(h.calls).toEqual(['codex', 'kiro'])
})

test('delegation does not chain: the recipient handing off again is not followed', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({
    codex: handsOff('reviewer', 'check it'),
    claude: handsOff('kiro', 'and you check it too'),
  })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
  } finally {
    err.mockRestore()
  }
  // one hop per send: a mistaken `to` pointing back would otherwise loop
  expect(h.calls).toEqual(['codex', 'claude'])
})

test('an envelope naming nothing recognisable is reported and the turn stands', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('nobody', 'do something') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[] = []
  try {
    const r = await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
    lines = err.mock.calls.map((c) => String(c[0]))
    expect(r.final).toContain('done.')
  } finally {
    err.mockRestore()
  }
  expect(h.calls).toEqual(['codex'])
  expect(lines.join('\n')).toContain('nobody')
})

test('with delegation off an envelope is left alone', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('reviewer', 'check it') })
  await send({ db, cfg: cfg({ delegation: { enabled: false } }), adapterFor: h.adapterFor }, s, 'codex', 'go')
  expect(h.calls).toEqual(['codex'])
})

test('the delegated turn is linked to the turn that handed it over', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('reviewer', 'check it') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
  } finally {
    err.mockRestore()
  }
  const rows = db
    .query('SELECT agent, id, parent_turn_id FROM turn WHERE session_id = $id ORDER BY started_at')
    .all({ id: s.id }) as { agent: string; id: string; parent_turn_id: string | null }[]
  expect(rows[1]!.agent).toBe('claude')
  expect(rows[1]!.parent_turn_id).toBe(rows[0]!.id)
})

test('a recipient the user disabled is reported, and the original answer stands', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('reviewer', 'check it') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[] = []
  let final = ''
  try {
    // the role resolves to claude, but claude is turned off in this config
    const r = await send(
      { db, cfg: cfg({ agents: { claude: { enabled: false } } }), adapterFor: h.adapterFor },
      s, 'codex', 'do the thing',
    )
    lines = err.mock.calls.map((c) => String(c[0]))
    final = r.final
  } finally {
    err.mockRestore()
  }
  expect(h.calls).toEqual(['codex'])
  expect(final).toContain('done.')
  // silence here would leave the user believing a review happened
  expect(lines.join('\n')).toContain('claude')
})
