import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import {
  createSession,
  currentSession,
  deleteSession,
  getSessionBySlug,
  listSessions,
  touchSession,
  upsertBinding,
  getBinding,
  listBindings,
  recordTurn,
  recordEvent,
  setGateResult,
  bumpBinding,
  acquireLock,
  releaseLock,
  lockOwner,
  reclaimStaleLock,
} from '../src/store/queries'

const db = () => openDb(':memory:')

test('a created session is readable by slug', () => {
  const d = db()
  const s = createSession(d, { slug: 'auth-refactor', goal: 'refactor auth', cwd: '/x', lead: 'claude' })
  const found = getSessionBySlug(d, 'auth-refactor')
  expect(found?.id).toBe(s.id)
  expect(found?.goal).toBe('refactor auth')
  expect(found?.status).toBe('active')
})

test('sessions are listed newest first', () => {
  const d = db()
  createSession(d, { slug: 'one', goal: 'a', cwd: '/x', lead: 'claude' })
  createSession(d, { slug: 'two', goal: 'b', cwd: '/x', lead: 'claude' })
  expect(listSessions(d).map((s) => s.slug)).toEqual(['two', 'one'])
})

test('the current session for a directory is the most recently touched one', () => {
  const d = db()
  const a = createSession(d, { slug: 'a', goal: 'a', cwd: '/repo', lead: 'claude' })
  const b = createSession(d, { slug: 'b', goal: 'b', cwd: '/repo', lead: 'claude' })
  createSession(d, { slug: 'c', goal: 'c', cwd: '/other', lead: 'claude' })
  expect(currentSession(d, '/repo')?.id).toBe(b.id)
  touchSession(d, a.id)
  expect(currentSession(d, '/repo')?.id).toBe(a.id)
  expect(currentSession(d, '/nowhere')).toBe(null)
})

test('deleting a session removes its bindings and turns', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'x', effort: 'high', permission: 'edit' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  deleteSession(d, s.id)
  expect(getSessionBySlug(d, 's')).toBe(null)
  expect(listBindings(d, s.id)).toHaveLength(0)
})

test('deleting a session cascades through every table that references it, including its lock', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'x', effort: 'high', permission: 'edit' })
  const turnId = recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  recordEvent(d, turnId, 0, 'text', { hello: 'world' })
  acquireLock(d, s.id, 'owner-a')

  deleteSession(d, s.id)

  expect(d.query('SELECT * FROM session WHERE id = $id').get({ id: s.id })).toBe(null)
  expect(d.query('SELECT * FROM turn WHERE session_id = $id').get({ id: s.id })).toBe(null)
  expect(d.query('SELECT * FROM binding WHERE session_id = $id').get({ id: s.id })).toBe(null)
  expect(d.query('SELECT * FROM lock WHERE session_id = $id').get({ id: s.id })).toBe(null)
  expect(d.query('SELECT * FROM event WHERE turn_id = $id').get({ id: turnId })).toBe(null)
})

test('deleting a session rolls back the whole cascade if one of its statements fails', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'x', effort: 'high', permission: 'edit' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  // dropping `lock` makes the cascade's later DELETE FROM lock fail, after binding was already deleted
  d.exec('DROP TABLE lock')

  expect(() => deleteSession(d, s.id)).toThrow()
  expect(listBindings(d, s.id)).toHaveLength(1)
})

test('a session lock is exclusive, re-entrant for its owner, and released', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  expect(acquireLock(d, s.id, 'owner-a')).toBe(true)
  expect(acquireLock(d, s.id, 'owner-a')).toBe(true)
  expect(acquireLock(d, s.id, 'owner-b')).toBe(false)
  releaseLock(d, s.id, 'owner-b')
  expect(acquireLock(d, s.id, 'owner-b')).toBe(false)
  releaseLock(d, s.id, 'owner-a')
  expect(acquireLock(d, s.id, 'owner-b')).toBe(true)
})

test('a lock held by a dead process is reclaimed', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  d.query('INSERT INTO lock (session_id, owner, pid, acquired_at) VALUES ($s, $o, $p, $a)').run({
    s: s.id,
    o: 'ghost',
    p: 2147483000,
    a: Date.now(),
  })
  expect(lockOwner(d, s.id)).toBe(null)
  expect(acquireLock(d, s.id, 'live')).toBe(true)
})

test('a binding upsert is idempotent per agent', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'codex', foreignId: null, effort: 'high', permission: 'edit' })
  upsertBinding(d, { sessionId: s.id, agent: 'codex', foreignId: 'thread-1', effort: 'max', permission: 'edit' })
  expect(listBindings(d, s.id)).toHaveLength(1)
  const b = getBinding(d, s.id, 'codex')
  expect(b?.foreignId).toBe('thread-1')
  expect(b?.effort).toBe('max')
  expect(b?.status).toBe('bound')
})

test('a binding without a foreign id stays unbound', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'kiro', foreignId: null, effort: 'high', permission: 'edit' })
  expect(getBinding(d, s.id, 'kiro')?.status).toBe('unbound')
})

test('a turn records what it cost and how it was classified', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const turnId = recordTurn(d, {
    sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0,
    exitCode: 0, credits: 0.5, inputTokens: 100, outputTokens: 20, kind: 'implement',
  })
  const row = d.query('SELECT * FROM turn WHERE id = $id').get({ id: turnId }) as Record<string, unknown>
  expect(row.kind).toBe('implement')
  expect(row.input_tokens).toBe(100)
  expect(row.credits).toBeCloseTo(0.5)
  expect(row.gate_passed).toBe(null)
})

test('a turn records why it failed, not only that it did', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const turnId = recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: '', costUsd: 0, exitCode: 130 })
  d.query('UPDATE turn SET error = $e, error_kind = $k WHERE id = $id').run({
    id: turnId,
    e: 'konvoy was interrupted by SIGINT',
    k: 'interrupted',
  })
  const row = d.query('SELECT error_kind FROM turn WHERE id = $id').get({ id: turnId }) as Record<string, unknown>
  expect(row.error_kind).toBe('interrupted')
})

test('the objective gate result is recorded separately from the exit code', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const turnId = recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  setGateResult(d, turnId, false)
  const row = d.query('SELECT gate_passed, exit_code FROM turn WHERE id = $id').get({ id: turnId }) as Record<string, unknown>
  expect(row.gate_passed).toBe(0)
  expect(row.exit_code).toBe(0)
})

test('turns accumulate onto the binding', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'uuid-1', effort: 'high', permission: 'edit' })
  recordTurn(d, { sessionId: s.id, agent: 'claude', prompt: 'hi', final: 'ok', costUsd: 0.25, exitCode: 0 })
  bumpBinding(d, s.id, 'claude', 0.25)
  const b = getBinding(d, s.id, 'claude')
  expect(b?.turns).toBe(1)
  expect(b?.costUsd).toBeCloseTo(0.25)
})

test('the stale-lock reclaim deletes only the row it observed', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const DEAD = 2147483000

  d.query('INSERT INTO lock (session_id, owner, pid, acquired_at) VALUES ($s, $o, $p, $a)').run({
    s: s.id, o: 'ghost', p: DEAD, a: Date.now(),
  })
  expect(acquireLock(d, s.id, 'live')).toBe(true)
  expect(lockOwner(d, s.id)).toBe('live')

  d.query('DELETE FROM lock WHERE session_id = $s').run({ s: s.id })
  d.query('INSERT INTO lock (session_id, owner, pid, acquired_at) VALUES ($s, $o, $p, $a)').run({
    s: s.id, o: 'other', p: process.pid, a: Date.now(),
  })
  expect(reclaimStaleLock(d, s.id, 'ghost', DEAD)).toBe(false)
  expect(lockOwner(d, s.id)).toBe('other')
})

test('a binding keeps its bound status when a later turn fails to report an id', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'codex', foreignId: 'thread-1', effort: 'high', permission: 'edit' })
  upsertBinding(d, { sessionId: s.id, agent: 'codex', foreignId: null, effort: 'high', permission: 'edit' })
  const b = getBinding(d, s.id, 'codex')
  expect(b?.foreignId).toBe('thread-1')
  expect(b?.status).toBe('bound')
})
