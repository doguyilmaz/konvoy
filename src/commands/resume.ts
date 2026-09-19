import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { currentSession, getSessionBySlug, touchSession } from '../store/queries'
import { cmdRoster } from './roster'

export function cmdResume(db: Database, cfg: Config, cwd: string, slug?: string): number {
  const session = slug ? getSessionBySlug(db, slug) : currentSession(db, cwd)
  if (!session) {
    console.error(slug ? `no konvoy session named "${slug}"` : 'no konvoy session in this directory')
    return 2
  }
  touchSession(db, session.id)
  return cmdRoster(db, cfg, session.cwd, session.slug)
}
