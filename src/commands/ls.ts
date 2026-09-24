import type { Database } from 'bun:sqlite'
import { boundBindingCounts, currentSession, listSessions, sessionActivity } from '../store/queries'
import { ago, outputColor, table, tildify } from '../format'
import { agentIds } from '../config/schema'

export function cmdLs(db: Database, cwd = '', opts: { json?: boolean } = {}): number {
  const sessions = listSessions(db)
  const bound = boundBindingCounts(db)
  const activity = sessionActivity(db)
  // A bare `konvoy` here resumes exactly one of these, and knowing which is the difference
  // between a list and knowing what you are about to talk to. Marking every directory's own
  // newest session instead would star most rows in a list read from one place.
  const here = cwd === '' ? null : currentSession(db, cwd)
  if (opts.json) {
    console.log(
      JSON.stringify(
        sessions.map((s) => ({
          slug: s.slug,
          goal: s.goal,
          cwd: s.cwd,
          lead: s.lead,
          current: s.id === here?.id,
          bound: bound.get(s.id) ?? 0,
          turns: activity.get(s.id)?.turns ?? 0,
          createdAt: s.createdAt,
          lastTurnAt: activity.get(s.id)?.lastAt ?? null,
        })),
        null,
        2,
      ),
    )
    return 0
  }
  if (sessions.length === 0) {
    console.log('no konvoy sessions yet')
    return 0
  }
  const now = Date.now()
  console.log(
    table(
      ['', 'SESSION', 'LEAD', 'BOUND', 'TURNS', 'ACTIVE', 'DIR', 'GOAL'],
      sessions.map((s) => {
        const seen = activity.get(s.id)
        return [
          s.id === here?.id ? '*' : '',
          s.slug,
          s.lead,
          `${bound.get(s.id) ?? 0}/${agentIds.length}`,
          String(seen?.turns ?? 0),
          ago(seen?.lastAt ?? s.createdAt, now),
          tildify(s.cwd),
          s.goal,
        ]
      }),
      { right: [3, 4], color: outputColor(), agentColumn: 2 },
    ).trimEnd(),
  )
  return 0
}
