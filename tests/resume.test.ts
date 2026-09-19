import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { acquireLock, createSession, currentSession } from '../src/store/queries'
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
