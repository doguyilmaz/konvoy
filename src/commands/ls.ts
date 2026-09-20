import type { Database } from 'bun:sqlite'
import { boundBindingCounts, listSessions } from '../store/queries'

export function cmdLs(db: Database): number {
  const sessions = listSessions(db)
  if (sessions.length === 0) {
    console.log('no konvoy sessions yet')
    return 0
  }
  const bound = boundBindingCounts(db)
  for (const s of sessions) {
    console.log(`${s.slug}  ${bound.get(s.id) ?? 0}/4 bound  ${s.cwd}  ${s.goal}`)
  }
  return 0
}
