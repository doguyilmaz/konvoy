import { expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
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

test('a recorded turn keeps its parent', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const first = recordTurn(d, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  const second = recordTurn(d, {
    sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, parentTurnId: first,
  })
  const row = d.query('SELECT parent_turn_id FROM turn WHERE id = $id').get({ id: second }) as Record<string, unknown>
  expect(row.parent_turn_id).toBe(first)
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

// mirrors migration 0 verbatim: any real database that ever reached user_version 1 ran this
// first, so a fixture missing `session`/`binding`/etc. would not be a v1 database at all
const MIGRATION_0 = `CREATE TABLE session (
     id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
     cwd TEXT NOT NULL, lead TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     updated_seq INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE binding (
     session_id TEXT NOT NULL, agent TEXT NOT NULL, foreign_id TEXT,
     model TEXT, effort TEXT NOT NULL, permission TEXT NOT NULL,
     status TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0, credits REAL NOT NULL DEFAULT 0, last_seen INTEGER,
     PRIMARY KEY (session_id, agent));
   CREATE TABLE turn (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL,
     prompt TEXT NOT NULL, final TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0,
     credits REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0, kind TEXT, gate_passed INTEGER,
     exit_code INTEGER NOT NULL, error TEXT, error_kind TEXT,
     started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
   CREATE INDEX turn_kind_agent ON turn(kind, agent);
   CREATE TABLE lock (
     session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL,
     acquired_at INTEGER NOT NULL);
   CREATE TABLE event (
     turn_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
     payload TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (turn_id, seq));`

test('a database created before migration 1 gains the new turn columns', () => {
  const path = `/tmp/konvoy-test-migrate-${Bun.nanoseconds()}.db`
  const old = new Database(path)
  old.exec(`${MIGRATION_0}\n   PRAGMA user_version = 1;`)
  old.close()

  const d = openDb(path)
  const cols = (d.query('PRAGMA table_info(turn)').all() as { name: string }[]).map((c) => c.name)
  expect(cols).toContain('model')
  expect(cols).toContain('parent_turn_id')
  d.close()
})

test('a database created at user_version 2 gains the turn and session indexes when opened', () => {
  const path = `/tmp/konvoy-test-migrate-idx-${Bun.nanoseconds()}.db`
  const old = new Database(path)
  old.exec(`${MIGRATION_0}
   ALTER TABLE turn ADD COLUMN parent_turn_id TEXT;
   ALTER TABLE turn ADD COLUMN model TEXT;
   PRAGMA user_version = 2;`)
  old.close()

  const before = new Database(path)
  const beforeTurnIdx = (before.query("PRAGMA index_list('turn')").all() as { name: string }[]).map((r) => r.name)
  const beforeSessionIdx = (before.query("PRAGMA index_list('session')").all() as { name: string }[]).map(
    (r) => r.name,
  )
  expect(beforeTurnIdx).not.toContain('turn_session_id')
  expect(beforeSessionIdx).not.toContain('session_cwd_status')
  before.close()

  const d = openDb(path)
  const turnIdx = (d.query("PRAGMA index_list('turn')").all() as { name: string }[]).map((r) => r.name)
  const sessionIdx = (d.query("PRAGMA index_list('session')").all() as { name: string }[]).map((r) => r.name)
  expect(turnIdx).toContain('turn_session_id')
  expect(sessionIdx).toContain('session_cwd_status')
  d.close()
})

test('a recorded turn keeps its model', () => {
  const d = db()
  const s = createSession(d, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const turnId = recordTurn(d, {
    sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, model: 'opus-4',
  })
  const row = d.query('SELECT model FROM turn WHERE id = $id').get({ id: turnId }) as Record<string, unknown>
  expect(row.model).toBe('opus-4')
})

test('opening a file that is not a SQLite database names the path, not the raw driver error', async () => {
  const path = `/tmp/konvoy-test-notadb-${Bun.nanoseconds()}.db`
  await Bun.write(path, 'this is definitely not a sqlite file, just padding text')
  expect(() => openDb(path)).toThrow(new RegExp(`cannot open konvoy database at ${path}`))
  try {
    openDb(path)
    throw new Error('expected openDb to throw')
  } catch (e) {
    expect((e as Error).message).not.toContain('SQLITE_NOTADB')
  }
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

// A parent konvoy that is SIGKILLed never releases its lock; the agent it spawned still carries
// KONVOY_LEASE and re-acquires as the same owner. The row kept the dead parent's pid, so
// lockOwner read it as stale and any third process could reclaim the session mid-turn.
test('re-acquiring a lock as its owner adopts the caller pid so the lock reads as live', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  db.query('INSERT INTO lock (session_id, owner, pid, acquired_at) VALUES ($s, $o, $p, $t)').run({ s: s.id, o: 'lease-X', p: 2147483000, t: Date.now() })
  expect(lockOwner(db, s.id)).toBeNull()
  expect(acquireLock(db, s.id, 'lease-X')).toBe(true)
  const row = db.query('SELECT pid FROM lock WHERE session_id = $s').get({ s: s.id }) as { pid: number }
  expect(row.pid).toBe(process.pid)
  expect(lockOwner(db, s.id)).toBe('lease-X')
})

// konvoy is designed to run concurrently - the lease exists for a nested konvoy inside an agent,
// a dashboard sits beside a send. Before the fix, eight processes opening one fresh file threw
// between 3 and 8 times per round ("database is locked", "no such table: main.turn", "table
// session already exists"): migrations ran outside any transaction with no busy timeout. This
// uses real processes because the race is between processes; it carries no mutation entry
// because its red is probabilistic and a flaky gate is worse than none - the transaction is the
// structural guarantee, and this test is the standing observation of it.
test('eight processes opening one fresh database at once all succeed and agree on the schema version', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  const path = `${dir}/k.db`
  const procs = Array.from({ length: 8 }, () => Bun.spawn(['bun', 'tests/fixtures/open-db.ts', path], { stdout: 'pipe', stderr: 'pipe' }))
  const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()))
  await Promise.all(procs.map((p) => p.exited))
  const expected = (openDb(':memory:').query('PRAGMA user_version').get() as { user_version: number }).user_version
  const actual = (openDb(path).query('PRAGMA user_version').get() as { user_version: number }).user_version
  await Bun.$`rm -rf ${dir}`.quiet()
  expect(outs).toEqual(Array(8).fill('OK'))
  expect(actual).toBe(expected)
})

// Three adapters replay a foreign id after a flag and codex after a bare positional; an id that
// began with "-" would be offered to the CLI's flag parser. No CLI produces one today and a
// model cannot forge a stream line, but the write path is the one place to say what shape an
// id may have - every id konvoy has met: UUIDs, kiro's cli_<uuid>_<suffix>, opencode's ses_….
test('a foreign id that is not an id shape is not bound, and the binding stays unbound', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const good of ['f28732a4-4805-4893-b448-a88ec47002cd', 'cli_800eb035-b675-4d9d-8f81-c6b661c12936_de1B0Hdt', 'ses_f3f4b6290ffeKaZ38ZuQQ4wnB7', '01a0c0d3-eeba-7a93-8999-d74b91dcd5df']) {
      upsertBinding(db, { sessionId: s.id, agent: 'claude', foreignId: good, effort: 'high', permission: 'edit' })
      const row = db.query('SELECT foreign_id FROM binding WHERE session_id = $s AND agent = $a').get({ s: s.id, a: 'claude' }) as { foreign_id: string }
      expect(row.foreign_id).toBe(good)
    }
    upsertBinding(db, { sessionId: s.id, agent: 'kiro', foreignId: '--trust-all-tools', effort: 'high', permission: 'edit' })
    const bad = db.query('SELECT foreign_id, status FROM binding WHERE session_id = $s AND agent = $a').get({ s: s.id, a: 'kiro' }) as { foreign_id: string | null; status: string }
    expect(bad.foreign_id).toBeNull()
    expect(bad.status).toBe('unbound')
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toContain('--trust-all-tools')
  } finally {
    err.mockRestore()
  }
})
