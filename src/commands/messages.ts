import type { Database } from 'bun:sqlite'
import type { AgentId, Session } from '../types'
import { agentIds } from '../adapters'
import { currentSession, getSessionBySlug } from '../store/queries'
import { nearestCommand } from './table'

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

/** the same, for a command whose session is always named: rm, rename */
export function requireNamedSession(db: Database, slug: string): Session | null {
  const session = getSessionBySlug(db, slug)
  if (!session) console.error(noSessionNamed(slug))
  return session
}

export const unknownAgent = (name: string): string =>
  `unknown agent "${name}" - expected one of ${agentIds.join(', ')}`

// One wording for both entry points: `konvoy bogus` and `/bogus` inside the REPL. `prefix` is
// how the user got here, so the suggestion is offered in the form they typed.
export function unknownCommand(word: string, prefix: string): string {
  const near = nearestCommand(word)
  const help = prefix === '/' ? '/help lists them' : 'konvoy --help lists them'
  return near ? `unknown command "${prefix}${word}" - did you mean ${prefix}${near}?` : `unknown command "${prefix}${word}" - ${help}`
}

/** the agent a user named, or null with the reason already reported */
export function requireAgent(name: string): AgentId | null {
  if (!agentIds.includes(name as AgentId)) {
    console.error(unknownAgent(name))
    return null
  }
  return name as AgentId
}
