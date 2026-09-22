import type { Database } from 'bun:sqlite'
import { deleteSession, listBindings, lockOwner } from '../store/queries'
import { requireNamedSession } from './messages'

export function cmdRm(db: Database, cwd: string, slug: string, opts: { yes: boolean }): number {
  const session = requireNamedSession(db, slug)
  if (!session) return 2
  const busy = lockOwner(db, session.id)
  if (busy) {
    console.error(`"${slug}" has a turn running (${busy}) - wait for it to finish, then retry`)
    return 2
  }
  const bound = listBindings(db, session.id).filter((b) => b.foreignId)
  if (!opts.yes) {
    console.error(`this deletes konvoy session "${slug}" and its ${bound.length} binding(s)`)
    console.error(`the sessions inside each CLI are NOT deleted - re-run with --yes to proceed`)
    return 2
  }
  deleteSession(db, session.id)
  console.log(`removed ${slug}`)
  if (bound.length > 0) {
    console.log(`the following foreign sessions still exist and can be opened directly:`)
    for (const b of bound) console.log(`  ${b.agent}: ${b.foreignId}`)
  }
  return 0
}
