import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { acquireLock, createSession, currentSession, upsertBinding } from '../src/store/queries'
import { configSchema } from '../src/config/schema'
import { cmdResume } from '../src/commands/resume'
import { cmdRm } from '../src/commands/rm'

const cfg = configSchema.parse({})

test('resuming a named session makes it current', () => {
  const db = openDb(':memory:')
  const a = createSession(db, { slug: 'alpha', goal: 'a', cwd: '/repo', lead: 'claude' })
  createSession(db, { slug: 'beta', goal: 'b', cwd: '/repo', lead: 'claude' })
  expect(currentSession(db, '/repo')?.slug).toBe('beta')
  expect(cmdResume(db, cfg, '/repo', 'alpha')).toBe(0)
  expect(currentSession(db, '/repo')?.id).toBe(a.id)
})

test('resuming an unknown slug fails clearly', () => {
  const db = openDb(':memory:')
  expect(cmdResume(db, cfg, '/repo', 'nope')).toBe(2)
})

test('rm refuses without confirmation and succeeds with it', () => {
  const db = openDb(':memory:')
  createSession(db, { slug: 'doomed', goal: 'g', cwd: '/repo', lead: 'claude' })
  expect(cmdRm(db, '/repo', 'doomed', { yes: false })).toBe(2)
  expect(currentSession(db, '/repo')?.slug).toBe('doomed')
  expect(cmdRm(db, '/repo', 'doomed', { yes: true })).toBe(0)
  expect(currentSession(db, '/repo')).toBe(null)
})

test('rm refuses while a turn holds the lock', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'busy', goal: 'g', cwd: '/repo', lead: 'claude' })
  expect(acquireLock(db, s.id, 'someone-else')).toBe(true)
  expect(cmdRm(db, '/repo', 'busy', { yes: true })).toBe(2)
  expect(currentSession(db, '/repo')?.slug).toBe('busy')
})

test('rm reports the bound count, not the total binding count, and lists only bound survivors', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'convoy', goal: 'g', cwd: '/repo', lead: 'claude' })
  upsertBinding(db, {
    sessionId: s.id,
    agent: 'claude',
    foreignId: 'claude-thread-1',
    effort: 'high',
    permission: 'edit',
  })
  upsertBinding(db, { sessionId: s.id, agent: 'codex', foreignId: null, effort: 'high', permission: 'edit' })

  const err = spyOn(console, 'error').mockImplementation(() => {})
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(cmdRm(db, '/repo', 'convoy', { yes: false })).toBe(2)
    const refusal = err.mock.calls.map((c) => String(c[0]))
    expect(refusal.some((l) => l.includes('its 1 binding(s)'))).toBe(true)
    expect(refusal.some((l) => l.includes('its 2 binding(s)'))).toBe(false)

    expect(cmdRm(db, '/repo', 'convoy', { yes: true })).toBe(0)
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('claude: claude-thread-1'))).toBe(true)
    expect(lines.some((l) => l.includes('codex'))).toBe(false)
  } finally {
    err.mockRestore()
    log.mockRestore()
  }
})
