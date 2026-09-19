import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, upsertBinding } from '../src/store/queries'
import { attachPlan } from '../src/commands/attach'

function seeded() {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(db, { sessionId: s.id, agent: 'codex', foreignId: 'thread-7', effort: 'high', permission: 'edit' })
  return { db, s }
}

test('attaching a bound agent resumes its own session', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'codex').cmd).toEqual(['codex', 'resume', 'thread-7'])
})

test('attaching an unbound agent starts it fresh', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'kiro').cmd).toEqual(['kiro-cli', 'chat'])
})

test('a configured binary path replaces the default command name', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'codex', '/opt/codex/bin/codex').cmd[0]).toBe('/opt/codex/bin/codex')
})

test('the attach plan runs in the session directory', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'codex').cwd).toBe('/x')
})
