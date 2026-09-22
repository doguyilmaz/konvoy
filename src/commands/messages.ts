import type { Database } from 'bun:sqlite'
import type { Session } from '../types'
import { currentSession, getSessionBySlug } from '../store/queries'

// Every command that works on a session resolves it the same way and fails the same way. Four
// copies of this sentence drifted into naming only `konvoy new "<goal>"` and into saying "here"
// about a session the user had named, which is the state duplication always ends in.
export const NO_SESSION_HERE = 'no konvoy session here - run `konvoy` to start one, or `konvoy new "<goal>"` to name its goal'

export const noSessionNamed = (slug: string): string => `no konvoy session named "${slug}"`

/** the session a command was pointed at, or null with the reason already reported */
export function requireSession(db: Database, cwd: string, slug?: string): Session | null {
  const session = slug ? getSessionBySlug(db, slug) : currentSession(db, cwd)
  if (!session) console.error(slug ? noSessionNamed(slug) : NO_SESSION_HERE)
  return session
}
