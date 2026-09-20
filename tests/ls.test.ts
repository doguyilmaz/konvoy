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
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.startsWith('a  ') && l.includes('2/4 bound'))).toBe(true)
    expect(lines.some((l) => l.startsWith('b  ') && l.includes('0/4 bound'))).toBe(true)
  } finally {
    log.mockRestore()
  }
})
