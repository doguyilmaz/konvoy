import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, recordTurn } from '../src/store/queries'
import { cmdLog, cmdShow, outcome } from '../src/commands/log'

function seeded() {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'token-refresh', goal: 'g', cwd: '/repo', lead: 'claude' })
  const ok = recordTurn(db, { sessionId: s.id, agent: 'claude', prompt: 'fix the refresh', final: '# Done\nswitched it', exitCode: 0, costUsd: 0.06, inputTokens: 24400, outputTokens: 311 })
  const rated = recordTurn(db, { sessionId: s.id, agent: 'codex', prompt: 'review it', final: '', exitCode: 1, costUsd: 0 })
  db.query("UPDATE turn SET error_kind = 'rate', error = 'hit your weekly limit' WHERE id = $id").run({ id: rated })
  return { db, s, ok, rated }
}

function capture(fn: () => number): { code: number; out: string; err: string } {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const code = fn()
    return { code, out: log.mock.calls.map((c) => String(c[0])).join('\n'), err: err.mock.calls.map((c) => String(c[0])).join('\n') }
  } finally {
    log.mockRestore()
    err.mockRestore()
  }
}

test('log lists the turns newest first, numbered the way show counts them', () => {
  const { db } = seeded()
  const { code, out } = capture(() => cmdLog(db, '/repo', {}))
  expect(code).toBe(0)
  const lines = out.split('\n')
  expect(lines[0]).toMatch(/^#\s+WHEN\s+AGENT\s+OUTCOME/)
  expect(lines[1]).toMatch(/^1\s.*codex\s+rate\s/)
  expect(lines[1]).toContain('review it')
  expect(lines[2]).toMatch(/^2\s.*claude\s+ok\s/)
  expect(lines[2]).toContain('24.4k')
  expect(lines[2]).toContain('$0.06')
})

test('log --json carries every field and the outcome word, for a script', () => {
  const { db } = seeded()
  const { out } = capture(() => cmdLog(db, '/repo', { json: true, limit: 1 }))
  const rows = JSON.parse(out) as { n: number; agent: string; outcome: string; errorKind: string }[]
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ n: 1, agent: 'codex', outcome: 'rate', errorKind: 'rate' })
})

test('show prints a turn whole: the header and prompt as chrome, the answer alone on stdout', () => {
  const { db } = seeded()
  const { code, out, err } = capture(() => cmdShow(db, '/repo', { which: '2' }))
  expect(code).toBe(0)
  expect(out).toBe('# Done\nswitched it')
  expect(err).toContain('#2')
  expect(err).toContain('› fix the refresh')
})

test('show names what went wrong when a turn has no answer, and refuses a number past the end', () => {
  const { db } = seeded()
  expect(capture(() => cmdShow(db, '/repo', {})).err).toContain('no answer: hit your weekly limit')
  const past = capture(() => cmdShow(db, '/repo', { which: '9' }))
  expect(past.code).toBe(2)
  expect(past.err).toContain('fewer than 9 turns')
  expect(capture(() => cmdShow(db, '/repo', { which: 'x' })).code).toBe(2)
})

test('an outcome is one word for how a turn ended', () => {
  const base = { id: 'x', agent: 'claude' as const, prompt: '', inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0, gatePassed: null, parentTurnId: null, model: null, startedAt: 0, endedAt: 0, error: null }
  expect(outcome({ ...base, final: 'a', exitCode: 0, errorKind: null })).toBe('ok')
  expect(outcome({ ...base, final: '', exitCode: -1, errorKind: null })).toBe('running')
  expect(outcome({ ...base, final: 'partial', exitCode: 130, errorKind: 'interrupted' })).toBe('interrupted')
  expect(outcome({ ...base, final: 'a', exitCode: 0, errorKind: 'rate' })).toBe('ok, then rate')
  expect(outcome({ ...base, final: '', exitCode: 1, errorKind: 'crash' })).toBe('crash')
})
