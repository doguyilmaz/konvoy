import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, upsertBinding } from '../src/store/queries'
import { cmdLs } from '../src/commands/ls'

test('cmdLs issues one bindings query regardless of session count', () => {
  const d = openDb(':memory:')
  for (let i = 0; i < 5; i++) {
    const s = createSession(d, { slug: `s${i}`, goal: 'g', cwd: '/x', lead: 'claude' })
    upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'thread', effort: 'high', permission: 'edit' })
  }

  const querySpy = spyOn(d, 'query')
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    cmdLs(d)
    const bindingQueries = querySpy.mock.calls.filter((c) => String(c[0]).includes('FROM binding'))
    expect(bindingQueries).toHaveLength(1)
  } finally {
    querySpy.mockRestore()
    log.mockRestore()
  }
})

test('cmdLs still reports the right bound count per session', () => {
  const d = openDb(':memory:')
  const a = createSession(d, { slug: 'a', goal: 'g', cwd: '/x', lead: 'claude' })
  const b = createSession(d, { slug: 'b', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: a.id, agent: 'claude', foreignId: 'thread', effort: 'high', permission: 'edit' })
  upsertBinding(d, { sessionId: a.id, agent: 'codex', foreignId: 'thread', effort: 'high', permission: 'edit' })
  upsertBinding(d, { sessionId: b.id, agent: 'claude', foreignId: null, effort: 'high', permission: 'edit' })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    cmdLs(d)
    // one table, printed once: the counts are cells now, not a "2/4 bound" phrase per line. With
    // no cwd given nothing is current, so the marker column is empty everywhere and dropped.
    const out = log.mock.calls.map((c) => String(c[0])).join('\n')
    const rows = out.trim().split('\n')
    expect(rows[0]!.startsWith('SESSION')).toBe(true)
    expect(rows.find((l) => /^a\s/.test(l))).toContain('2/4')
    expect(rows.find((l) => /^b\s/.test(l))).toContain('0/4')
  } finally {
    log.mockRestore()
  }
})

// `konvoy ls` printed one run-on line per session - slug, bound count, path and goal separated by
// two spaces and nothing else - so a list of five sessions had no columns to read down. It goes
// through the same table every other command uses now.
test('ls prints one aligned table, with the current session marked', () => {
  const d = openDb(':memory:')
  createSession(d, { slug: 'token-refresh', goal: 'fix the token refresh', cwd: '/repo', lead: 'claude' })
  const current = createSession(d, { slug: 'sinkaf-8f3a', goal: '', cwd: '/other', lead: 'codex' })
  upsertBinding(d, { sessionId: current.id, agent: 'codex', foreignId: 'thread', effort: 'high', permission: 'edit' })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  let out: string
  try {
    expect(cmdLs(d, '/other')).toBe(0)
    out = log.mock.calls.map((c) => String(c[0])).join('\n')
  } finally {
    log.mockRestore()
  }

  const lines = out.trim().split('\n')
  expect(lines[0]).toContain('SESSION')
  expect(lines[0]).toContain('BOUND')
  expect(lines[0]).toContain('LEAD')
  expect(lines[0]).toContain('GOAL')

  // the goal column starts at one place for every row, which is the whole point
  const goalColumn = lines.slice(1).map((l) => l.indexOf('/'))
  expect(new Set(goalColumn).size).toBe(1)

  // the most recent session is the one a bare `konvoy` resumes, so it is marked
  const currentRow = lines.find((l) => l.includes('sinkaf-8f3a'))!
  expect(currentRow.startsWith('*')).toBe(true)
  expect(lines.find((l) => l.includes('token-refresh'))!.startsWith('*')).toBe(false)
  expect(currentRow).toContain('1/4')
})
