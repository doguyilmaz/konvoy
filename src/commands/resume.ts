import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { touchSession } from '../store/queries'
import { requireSession } from './messages'
import { cmdRoster } from './roster'

export function cmdResume(db: Database, cfg: Config, cwd: string, slug?: string): number {
  const session = requireSession(db, cwd, slug)
  if (!session) return 2
  touchSession(db, session.id)
  return cmdRoster(db, cfg, session.cwd, session.slug)
}
