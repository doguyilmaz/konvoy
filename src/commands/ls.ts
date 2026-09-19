import type { Database } from 'bun:sqlite'
import { listBindings, listSessions } from '../store/queries'

export function cmdLs(db: Database): number {
  const sessions = listSessions(db)
  if (sessions.length === 0) {
    console.log('no konvoy sessions yet')
    return 0
  }
  for (const s of sessions) {
    const bound = listBindings(db, s.id).filter((b) => b.foreignId).length
    console.log(`${s.slug}  ${bound}/4 bound  ${s.cwd}  ${s.goal}`)
  }
  return 0
}
