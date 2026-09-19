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
     exit_code INTEGER NOT NULL, error TEXT,
     started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
   CREATE INDEX turn_kind_agent ON turn(kind, agent);
   CREATE TABLE lock (
     session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL,
     acquired_at INTEGER NOT NULL);
   CREATE TABLE event (
     turn_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
     payload TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (turn_id, seq));`,
]

export function openDb(path: string): Database {
  if (path !== ':memory:') {
    const dir = dirname(path)
    Bun.spawnSync(['mkdir', '-p', dir])
  }
  const db = new Database(path, { create: true, strict: true })
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]!)
    db.exec(`PRAGMA user_version = ${v + 1}`)
  }
  return db
}
