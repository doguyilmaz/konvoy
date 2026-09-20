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
  // The real adapter's own turn() builds the actual argv a CLI would receive — capturing its
  // cmd here (rather than re-deriving withPrelude by hand) is what makes a check against it
  // prove the instruction reaches an actual command line, not just this harness's idea of one.
  const cmds: Record<string, string[]> = {}
  const adapterFor = (agent: AgentId): Adapter => ({
    ...claudeAdapter,
    id: agent,
    turn: (ctx) => {
      calls.push(agent)
      seen[agent] = withPrelude(ctx)
      cmds[agent] = claudeAdapter.turn(ctx).cmd
      return { cmd: ['bun', 'tests/fixtures/fake-agent.ts', ...(script[agent] ?? ok(agent))], cwd: process.cwd() }
    },
  })
  return { calls, seen, cmds, adapterFor }
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

// The one test the task asks for: every earlier test in this file checks a single piece of
// the path in isolation. None of them look at the sending agent's own command line, so none
// would fail if `ctx.delegation` were only threaded to the recipient and never to codex —
// exactly the shape of the four capabilities (sparkline, estimateUsd, the prelude,
// parseEnvelope) that were built, unit-tested, and never reachable from a real run. This one
// drives send() once and checks the whole path in that single run: the instruction reached
// codex's real command line, the named recipient actually ran, its prelude carried codex's
// own task/open/decisions rather than a derived summary, and the two turns are linked in the
// store — any one missing means the feature is not connected.
test('end to end: delegation reaches the command line, runs the recipient, and links the turns', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({
    codex: ok(
      'done.\n\n<<<konvoy\n' +
        'to: reviewer\n' +
        'task: check the refresh path\n' +
        'open:\n- the device clock drifts\n' +
        'decisions:\n- refresh on 401 rather than on a timer\n' +
        '>>>',
    ),
  })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[] = []
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'do the thing')
    lines = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }

  // codex was asked for an envelope: the instruction reached its real command line, built by
  // the same claudeAdapter.turn() a live run would use — not a hand-built ctx.
  expect(h.cmds.codex!.join(' ')).toContain('<<<konvoy')

  // it emitted one, and the named recipient (the reviewer role, resolved to claude) ran
  expect(h.calls).toEqual(['codex', 'claude'])
  expect(lines.join('\n')).toContain('codex handed off to claude')

  // the recipient's prelude carried codex's own task, its open question and its stated
  // decision — not a summary konvoy invented — and never claims the intent went unrecorded
  const recipientCmd = h.cmds.claude!.join(' ')
  expect(recipientCmd).toContain('check the refresh path')
  expect(recipientCmd).toContain('the device clock drifts')
  expect(recipientCmd).toContain('refresh on 401 rather than on a timer')
  expect(recipientCmd.toLowerCase()).not.toContain('was not recorded')

  // both turns are linked in the store through parent_turn_id
  const rows = db
    .query('SELECT agent, id, parent_turn_id FROM turn WHERE session_id = $id ORDER BY started_at')
    .all({ id: s.id }) as { agent: string; id: string; parent_turn_id: string | null }[]
  expect(rows[0]!.agent).toBe('codex')
  expect(rows[1]!.agent).toBe('claude')
  expect(rows[1]!.parent_turn_id).toBe(rows[0]!.id)
})

// The handoff notice quotes the sender's own task text. parseEnvelope passes control bytes
// through untouched, so this is the one place a model's escape sequence would reach the
// terminal inside a line konvoy signed with its own name.
test('the handoff notice is one clean line even when the task carries an escape sequence', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'codex' })
  const h = harness({ codex: handsOff('reviewer', 'check\u001b[2K the retry') })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[] = []
  try {
    await send({ db, cfg: cfg(), adapterFor: h.adapterFor }, s, 'codex', 'go')
    lines = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
  expect(lines.find((l) => l.includes('handed off to claude'))).toBe('konvoy: codex handed off to claude — "check the retry"')
})
