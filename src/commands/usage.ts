import type { Database } from 'bun:sqlite'
import { currentSession, getSessionBySlug, usageAcrossSessions, usageForSession } from '../store/queries'
import { formatUsage } from '../format'

export function cmdUsage(db: Database, cwd: string, opts: { all: boolean; slug?: string }): number {
  if (opts.all) {
    const rows = usageAcrossSessions(db)
    if (rows.length === 0) {
      console.log('no turns recorded yet')
      return 0
    }
    console.log('all sessions')
    console.log(formatUsage(rows))
    return 0
  }

  const session = opts.slug ? getSessionBySlug(db, opts.slug) : currentSession(db, cwd)
  if (!session) {
    console.error('no konvoy session here — run `konvoy new "<goal>"` first')
    return 2
  }
  const rows = usageForSession(db, session.id)
  if (rows.length === 0) {
    console.log(`session ${session.slug} — no turns yet`)
    return 0
  }
  console.log(`session ${session.slug}`)
  console.log(formatUsage(rows))
  console.log('spend is in each agent\'s own unit; a dash means the CLI reported none')
  return 0
}
