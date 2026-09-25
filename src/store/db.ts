import { Database } from 'bun:sqlite'
import { dirname } from '../paths'

const MIGRATIONS: string[] = [
  `CREATE TABLE session (
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
     payload TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (turn_id, seq));`,
  `ALTER TABLE turn ADD COLUMN parent_turn_id TEXT;
   ALTER TABLE turn ADD COLUMN model TEXT;`,
  `CREATE INDEX turn_session_id ON turn(session_id);
   CREATE INDEX session_cwd_status ON session(cwd, status);`,
  // what /retry reads: the latest turn a person asked for, which has no parent. Applying it is also
  // what makes a store an earlier konvoy created private (see openDb)
  `CREATE INDEX turn_session_parent ON turn(session_id, parent_turn_id);`,
  // the REPL's prompt history, per directory (src/history.ts)
  `CREATE TABLE prompt_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT, cwd TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX prompt_history_cwd ON prompt_history(cwd, id);`,
]

// SQLite refuses to create a database whose directory is missing, so konvoy has to make it. It
// used to run `mkdir -p` up front on every open, which cost a process per command and made konvoy
// depend on finding mkdir on PATH: a child started with a PATH that has no mkdir died with
// `Executable not found in $PATH: "mkdir"` before opening anything. Bun 1.4.2 offers no
// synchronous directory create (`Bun.$` is async, `node:*` imports are ruled out), so the open is
// attempted first and the directory made only when that fails - no process in the steady state,
// which is every command after the first - and mkdir is resolved to an absolute path so PATH
// cannot decide whether konvoy starts. Bun.which itself falls back to a default search path.
function ensureDirectory(dir: string): void {
  const mkdir = Bun.which('mkdir') ?? '/bin/mkdir'
  // owner-only: the store holds every prompt and every answer
  const made = Bun.spawnSync([mkdir, '-p', '-m', '700', dir], { stdout: 'ignore', stderr: 'pipe' })
  if (made.exitCode !== 0) {
    const reason = made.stderr.toString().trim() || `exit ${made.exitCode}`
    throw new Error(`cannot create the konvoy store directory ${dir}: ${reason}`)
  }
}

function makePrivate(path: string): void {
  const chmod = Bun.which('chmod') ?? '/bin/chmod'
  Bun.spawnSync([chmod, '600', path, `${path}-wal`, `${path}-shm`], { stdout: 'ignore', stderr: 'ignore' })
  Bun.spawnSync([chmod, '700', dirname(path)], { stdout: 'ignore', stderr: 'ignore' })
}

function open(path: string): Database {
  try {
    return new Database(path, { create: true, strict: true })
  } catch (error) {
    if (path === ':memory:') throw error
    ensureDirectory(dirname(path))
    return new Database(path, { create: true, strict: true })
  }
}

export function openDb(path: string): Database {
  let db: Database
  try {
    db = open(path)
    if (path !== ':memory:') {
      // konvoy runs concurrently by design - a nested konvoy inside an agent, a dashboard beside
      // a send. Set before anything that takes a lock: switching a fresh file to WAL needs an
      // exclusive one, and without the timeout the losers of that first statement throw
      db.exec('PRAGMA busy_timeout = 5000')
      // the journal-mode switch needs an exclusive lock and SQLite does not run the busy handler
      // for it, so with several openers racing the losers get SQLITE_BUSY on this one statement.
      // The mode is persistent in the file: the winner's switch holds for everyone, a loser moves on.
      try {
        db.exec('PRAGMA journal_mode = WAL')
      } catch {
        // another opener is switching it right now
      }
      // In WAL mode NORMAL cannot corrupt the database; what it gives up is the last commits on a
      // power cut. It takes an fsync off every commit, and a turn commits once per event it records.
      db.exec('PRAGMA synchronous = NORMAL')
    }
    // one transaction for every pending migration: a loser of the open race re-reads
    // user_version under the write lock and finds nothing left to do, and a process that dies
    // mid-migration leaves no half-applied schema behind
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      // Every prompt and answer lives here, and the default umask left the store readable by anyone
      // on the machine. Whenever a migration runs - a store being created, or one an earlier konvoy left -
      // the files and their directory are made owner-only; the WAL mode switch above has already
      // created -wal and -shm by then, so they are included
      if (current < MIGRATIONS.length && path !== ':memory:') makePrivate(path)
      for (let v = current; v < MIGRATIONS.length; v++) {
        db.exec(MIGRATIONS[v]!)
        db.exec(`PRAGMA user_version = ${v + 1}`)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot open konvoy database at ${path}: ${message}`)
  }
  return db
}
