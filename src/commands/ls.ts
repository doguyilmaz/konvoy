import type { Database } from 'bun:sqlite'
import { boundBindingCounts, currentSession, listSessions } from '../store/queries'
import { table } from '../format'

export function cmdLs(db: Database, cwd = ''): number {
  const sessions = listSessions(db)
  if (sessions.length === 0) {
    console.log('no konvoy sessions yet')
    return 0
  }
  const bound = boundBindingCounts(db)
  // A bare `konvoy` here resumes exactly one of these, and knowing which is the difference
  // between a list and knowing what you are about to talk to. Marking every directory's own
  // newest session instead would star most rows in a list read from one place.
  const here = cwd === '' ? null : currentSession(db, cwd)
  console.log(
    table(
      ['', 'SESSION', 'LEAD', 'BOUND', 'DIR', 'GOAL'],
      sessions.map((s) => [
        s.id === here?.id ? '*' : '',
        s.slug,
        s.lead,
        `${bound.get(s.id) ?? 0}/4`,
        s.cwd,
        s.goal,
      ]),
      { right: [3] },
    ).trimEnd(),
  )
  return 0
}
