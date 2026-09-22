import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { AgentId, Session } from '../types'
import { agentIds } from '../adapters'
import { resolveAgent } from '../config/load'
import { sessionDir } from '../paths'
import { currentSession, getSessionBySlug, lastTurnAgent, listSessions, setGoal } from '../store/queries'
import { cmdNew } from './new'
import { formatCommandList } from './table'

export interface ReplIo {
  lines: AsyncIterable<string>
  write: (text: string) => void
  tty: boolean
}

/** runs one command line through the command table, as `konvoy <tokens>` would, for the given session */
export type Run = (tokens: string[], slug: string) => Promise<number> | number

const INNER = `  /use <agent>                             talk to this agent from now on
  /goal <text>                             set the session goal
  /help                                    this list
  /quit                                    leave (Ctrl-D does too)
`

export const replHelp = (): string => INNER + formatCommandList().replaceAll('  konvoy ', '  /') + '\n'

export async function startSession(db: Database, cfg: Config, cwd: string, slug?: string): Promise<Session | null> {
  if (slug) return getSessionBySlug(db, slug)
  const current = currentSession(db, cwd)
  if (current) return current
  if ((await cmdNew(db, cfg, cwd, '')) !== 0) return null
  return currentSession(db, cwd)
}

export async function runRepl(
  io: ReplIo,
  db: Database,
  cfg: Config,
  cwd: string,
  start: Session,
  run: Run,
): Promise<number> {
  let session = start
  let agent: AgentId = session.lead
  const prompt = (): void => {
    if (io.tty) io.write(`${session.slug} ${agent}> `)
  }
  const refresh = (): boolean => {
    const fresh = listSessions(db).find((s) => s.id === session.id)
    if (fresh) session = fresh
    return fresh !== undefined
  }

  prompt()
  for await (const raw of io.lines) {
    const line = raw.trim()
    if (line === '') {
      prompt()
      continue
    }
    if (!line.startsWith('/')) {
      await run(['send', agent, line], session.slug)
      // failover never falls back, so the agent that answered is the one to keep talking to
      const moved = lastTurnAgent(db, session.id)
      if (moved && moved !== agent) agent = moved
      prompt()
      continue
    }

    const [cmd = '', ...rest] = line.slice(1).split(/\s+/)
    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') break
    if (cmd === 'help') {
      io.write(replHelp())
    } else if (cmd === 'use') {
      const next = rest[0] ?? ''
      if (!agentIds.includes(next as AgentId)) {
        console.error(`unknown agent "${next}" - expected one of ${agentIds.join(', ')}`)
      } else if (!resolveAgent(cfg, next as AgentId).enabled) {
        console.error(`${next} is disabled in this konvoy config`)
      } else {
        agent = next as AgentId
      }
    } else if (cmd === 'goal') {
      const goal = rest.join(' ')
      if (!goal) {
        console.error('usage: /goal <text>')
      } else {
        setGoal(db, session.id, goal)
        const context = Bun.file(`${sessionDir(session.cwd, session.slug)}/CONTEXT.md`)
        if (await context.exists()) await Bun.write(context, `${await context.text()}\n## Goal\n\n${goal}\n`)
        refresh()
      }
    } else if (cmd === 'rename') {
      if (rest.length === 0) console.error('usage: /rename <new-name>')
      else {
        await run(['rename', session.slug, rest.join(' ')], session.slug)
        refresh()
      }
    } else if (cmd === 'attach') {
      await run(['attach', rest[0] ?? agent, ...rest.slice(1)], session.slug)
    } else {
      await run([cmd, ...rest], session.slug)
      if (cmd === 'resume' && rest[0]) {
        const target = getSessionBySlug(db, rest[0])
        if (target) {
          session = target
          agent = target.lead
        }
      } else if (cmd === 'new') {
        const created = currentSession(db, cwd)
        if (created) {
          session = created
          agent = created.lead
        }
      } else if (!refresh()) {
        console.error(`session ${session.slug} is gone`)
        return 0
      }
    }
    prompt()
  }
  if (io.tty) io.write('\n')
  return 0
}
