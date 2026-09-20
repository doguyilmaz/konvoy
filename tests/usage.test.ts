import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, recordTurn, setGateResult, usageForSession, usageAcrossSessions } from '../src/store/queries'
import { formatUsage } from '../src/format'

const db = () => openDb(':memory:')

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
  const a = recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  setGateResult(d, a, true)

  const row = usageForSession(d, s.id)[0]!
  expect(row.turns).toBe(2)
  expect(row.gateKnown).toBe(1)
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
