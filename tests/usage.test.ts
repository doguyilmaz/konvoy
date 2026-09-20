import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { cmdUsage } from '../src/commands/usage'
import {
  createSession,
  recordTurn,
  setGateResult,
  turnsPerDay,
  turnsPerDayByAgent,
  usageForSession,
  usageAcrossSessions,
} from '../src/store/queries'
import { formatUsage } from '../src/format'
import { configSchema } from '../src/config/schema'

const db = () => openDb(':memory:')
const cfg = configSchema.parse({})
const pricedCfg = configSchema.parse({
  pricing: {
    asOf: '2026-09-19',
    models: {},
    credits: { kiro: { usdPerCredit: 0.02 } },
  },
})

test('usage is grouped per agent with tokens summed', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0.5, exitCode: 0, inputTokens: 100, outputTokens: 20 })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0.25, exitCode: 0, inputTokens: 50, outputTokens: 10 })
  recordTurn(d, { sessionId: s.id, agent: 'kiro', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, credits: 0.07, inputTokens: 5, outputTokens: 1 })

  const rows = usageForSession(d, s.id)
  const claude = rows.find((r) => r.agent === 'claude')!
  expect(claude.turns).toBe(2)
  expect(claude.inputTokens).toBe(150)
  expect(claude.costUsd).toBeCloseTo(0.75)
  const kiro = rows.find((r) => r.agent === 'kiro')!
  expect(kiro.credits).toBeCloseTo(0.07)
  expect(kiro.costUsd).toBe(0)
})

test('an agent with no turns does not appear', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  expect(usageForSession(d, s.id).map((r) => r.agent)).toEqual(['codex'])
})

test('the gate rate counts only turns that have a verdict', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  // asymmetric on purpose (2 known, 1 unknown): a 1/1 split can't tell "known" and
  // "unknown" apart if the CASE that computes gate_known is inverted — both readings
  // land on 1. This shape breaks under inversion (2 vs 1) instead of surviving it.
  const a = recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  const b = recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  setGateResult(d, a, true)
  setGateResult(d, b, false)

  const row = usageForSession(d, s.id)[0]!
  expect(row.turns).toBe(3)
  expect(row.gateKnown).toBe(2)
  expect(row.gatePassed).toBe(1)
})

test("usage for one session excludes another session's turns", () => {
  const d = db()
  const one = createSession(d, { slug: 'one', goal: 'g', cwd: '/x', lead: 'claude' })
  const two = createSession(d, { slug: 'two', goal: 'g', cwd: '/y', lead: 'claude' })
  recordTurn(d, { sessionId: one.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0 })
  recordTurn(d, { sessionId: two.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 5, exitCode: 0 })
  const rows = usageForSession(d, one.id)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.turns).toBe(1)
  expect(rows[0]!.costUsd).toBeCloseTo(1)
})

test('usage across sessions sums every session', () => {
  const d = db()
  const one = createSession(d, { slug: 'one', goal: 'g', cwd: '/x', lead: 'claude' })
  const two = createSession(d, { slug: 'two', goal: 'g', cwd: '/y', lead: 'claude' })
  recordTurn(d, { sessionId: one.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0, inputTokens: 10 })
  recordTurn(d, { sessionId: two.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 2, exitCode: 0, inputTokens: 20 })
  const row = usageAcrossSessions(d)[0]!
  expect(row.turns).toBe(2)
  expect(row.inputTokens).toBe(30)
  expect(row.costUsd).toBeCloseTo(3)
})

test('an unreported cost shows as a dash, never as zero', () => {
  const out = formatUsage([
    { agent: 'claude', turns: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.75, credits: 0, gatePassed: 0, gateKnown: 0 },
    { agent: 'kiro', turns: 1, inputTokens: 5, outputTokens: 1, costUsd: 0, credits: 0.067, gatePassed: 0, gateKnown: 0 },
    { agent: 'opencode', turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0, gatePassed: 0, gateKnown: 0 },
  ])
  expect(out).toContain('$0.75')
  expect(out).toContain('0.067 cr')
  const opencodeLine = out.split('\n').find((l) => l.startsWith('opencode'))!
  expect(opencodeLine).toContain('-')
  expect(opencodeLine).not.toContain('$0.00')
})

test('the spend column reads a dash, not a zero, when nothing was reported', () => {
  // gateKnown is 1 here so the GATE column reads "1/1", not "-" — isolating the SPEND
  // cell from the coincidental dash the GATE column would otherwise contribute.
  const out = formatUsage([
    { agent: 'opencode', turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0, gatePassed: 1, gateKnown: 1 },
  ])
  const row = out.split('\n').find((l) => l.startsWith('opencode'))!
  const cells = row.trim().split(/\s{2,}/)
  expect(cells[4]).toBe('-')
})

test('spend prefers credits over dollars when a row somehow carries both', () => {
  const out = formatUsage([
    { agent: 'claude', turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 1.5, credits: 0.02, gatePassed: 1, gateKnown: 1 },
  ])
  const row = out.split('\n').find((l) => l.startsWith('claude'))!
  const cells = row.trim().split(/\s{2,}/)
  expect(cells[4]).toBe('0.020 cr')
})

test('a gate rate is shown only where a verdict exists', () => {
  const withVerdict = formatUsage([
    { agent: 'codex', turns: 4, inputTokens: 1, outputTokens: 1, costUsd: 0, credits: 0, gatePassed: 3, gateKnown: 4 },
  ])
  expect(withVerdict).toContain('3/4')
  const without = formatUsage([
    { agent: 'codex', turns: 4, inputTokens: 1, outputTokens: 1, costUsd: 0, credits: 0, gatePassed: 0, gateKnown: 0 },
  ])
  expect(without).not.toContain('0/0')
})

test('an agent billed in credits and one billed in dollars appear in the same ~USD column with comparable figures', () => {
  const pricing = { asOf: '2026-09-19', models: {}, credits: { kiro: { usdPerCredit: 0.02 } } }
  const out = formatUsage(
    [
      { agent: 'claude', turns: 18, inputTokens: 0, outputTokens: 0, costUsd: 1.8, credits: 0, gatePassed: 0, gateKnown: 0 },
      { agent: 'kiro', turns: 9, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0.4, gatePassed: 0, gateKnown: 0 },
    ],
    pricing,
  )
  expect(out).toContain('~USD')
  const claudeLine = out.split('\n').find((l) => l.startsWith('claude'))!
  const kiroLine = out.split('\n').find((l) => l.startsWith('kiro'))!
  expect(claudeLine).toContain('$1.80')
  expect(kiroLine).toContain('$0.008')
})

test('the ~USD column is absent entirely when no pricing is configured', () => {
  const rows: Parameters<typeof formatUsage>[0] = [
    { agent: 'claude', turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 1.8, credits: 0, gatePassed: 0, gateKnown: 0 },
  ]
  expect(formatUsage(rows)).not.toContain('~USD')
  expect(formatUsage(rows, { asOf: '', models: {}, credits: {} })).not.toContain('~USD')
})

test('a row whose rate is not configured shows - in ~USD while still showing its native SPEND', () => {
  const pricing = { asOf: '2026-09-19', models: {}, credits: { kiro: { usdPerCredit: 0.02 } } }
  const out = formatUsage(
    [
      { agent: 'kiro', turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0.4, gatePassed: 0, gateKnown: 0 },
      { agent: 'opencode', turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0.07, gatePassed: 0, gateKnown: 0 },
    ],
    pricing,
  )
  const opencodeLine = out.split('\n').find((l) => l.startsWith('opencode'))!
  expect(opencodeLine).toContain('0.070 cr')
  const cells = opencodeLine.trim().split(/\s{2,}/)
  expect(cells[5]).toBe('-')
})

test('the units note names the asOf date when the ~USD column is present', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'kiro', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, credits: 0.4 })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    cmdUsage(d, pricedCfg, '/x', { all: false })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(lines.some((l) => l.includes('2026-09-19'))).toBe(true)
})

test('the units note stays plain when pricing is not configured', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0 })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    cmdUsage(d, cfg, '/x', { all: false })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(lines.some((l) => /\d{4}-\d{2}-\d{2}/.test(l))).toBe(false)
})

test('both usage tables explain the mixed SPEND unit, not only the per-session one', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'units', goal: 'g', cwd: '/repo', lead: 'claude' })
  recordTurn(db, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0 })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  let all: string[]
  let one: string[]
  try {
    cmdUsage(db, cfg, '/repo', { all: true })
    all = log.mock.calls.map((c) => String(c[0]))
    log.mockClear()
    cmdUsage(db, cfg, '/repo', { all: false })
    one = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }

  const note = (lines: string[]) => lines.some((l) => l.includes("each agent's own unit"))
  expect(note(one)).toBe(true)
  expect(note(all)).toBe(true)
})

test('usage --all on an empty database reports no turns and exits 0', () => {
  const d = db()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let code: number
  let lines: string[]
  try {
    code = cmdUsage(d, cfg, '/nowhere', { all: true })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(code).toBe(0)
  expect(lines).toContain('no turns recorded yet')
})

test('usage with no session in this directory reports the standard error and exits 2', () => {
  const d = db()
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let code: number
  let lines: string[]
  try {
    code = cmdUsage(d, cfg, '/nowhere', { all: false })
    lines = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
  expect(code).toBe(2)
  expect(lines).toContain('no konvoy session here — run `konvoy new "<goal>"` first')
})

test('a turn after midnight is counted on its own local day, not the UTC one', () => {
  const d = db()
  const s = createSession(d, { slug: 'late', goal: 'g', cwd: '/repo', lead: 'claude' })
  // 01:30 local is the previous day in UTC for any timezone ahead of it
  const ms = Date.parse('2026-09-21T01:30:00+03:00')
  const id = recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  d.query('UPDATE turn SET started_at = $ms WHERE id = $id').run({ ms, id })

  // en-CA formats as YYYY-MM-DD, so this is the machine's own local calendar day
  const expected = new Date(ms).toLocaleDateString('en-CA')
  expect(turnsPerDay(d)).toEqual([{ day: expected, count: 1 }])
})

test('turnsPerDayByAgent buckets by local day too, sharing the same day expression as turnsPerDay', () => {
  const d = db()
  const s = createSession(d, { slug: 'late2', goal: 'g', cwd: '/repo2', lead: 'claude' })
  const ms = Date.parse('2026-09-21T01:30:00+03:00')
  const id = recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  d.query('UPDATE turn SET started_at = $ms WHERE id = $id').run({ ms, id })

  const expected = new Date(ms).toLocaleDateString('en-CA')
  expect(turnsPerDayByAgent(d)).toEqual([{ agent: 'codex', day: expected, count: 1 }])
})

test('usage --chart prints the turns-per-day heatmap and the share-of-turns bars', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0 })
  recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0.5, exitCode: 0 })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    cmdUsage(d, cfg, '/x', { all: false, chart: true })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(lines.some((l) => l.includes('turns per day'))).toBe(true)
  expect(lines.some((l) => l.includes('share of turns'))).toBe(true)
  expect(lines.some((l) => l.includes('claude') && l.includes('%'))).toBe(true)
})

test('usage --chart also prints a per-agent turns-per-day sparkline', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0 })
  recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0.5, exitCode: 0 })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    cmdUsage(d, cfg, '/x', { all: false, chart: true })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(lines.some((l) => l.includes('turns per day by agent'))).toBe(true)
  const claudeLine = lines.find((l) => /^claude\s+[▁▂▃▄▅▆▇█]+$/.test(l))
  const codexLine = lines.find((l) => /^codex\s+[▁▂▃▄▅▆▇█]+$/.test(l))
  expect(claudeLine).toBeDefined()
  expect(codexLine).toBeDefined()
})

test('usage without --chart prints no chart output', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0 })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    cmdUsage(d, cfg, '/x', { all: false })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(lines.some((l) => l.includes('turns per day'))).toBe(false)
})

test('usage for a session with zero turns reports that and exits 0', () => {
  const d = db()
  createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let code: number
  let lines: string[]
  try {
    code = cmdUsage(d, cfg, '/x', { all: false })
    lines = log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
  expect(code).toBe(0)
  expect(lines).toContain('session s — no turns yet')
})
