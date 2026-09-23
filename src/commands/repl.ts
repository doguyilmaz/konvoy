import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { AgentId, Session } from '../types'
import { onExit } from '../core/children'
import { requireAgent } from './messages'
import { disabledAgent, resolveAgent } from '../config/load'
import { agentPaint, colorEnabled, palette } from '../style'
import { statusLine } from '../render'
import { sessionDir } from '../paths'
import { currentSession, getSessionBySlug, lastTurnAgent, listSessions, setGoal, usageForSession } from '../store/queries'
import { cmdNew } from './new'
import { commandTable, formatRows, type CommandRow } from './table'

export interface ReplIo {
  lines: AsyncIterable<string>
  write: (text: string) => void
  tty: boolean
  /** whether this io may carry colour, decided once from the environment by terminalIo */
  color?: boolean
  /** stop reading stdin while a command runs, so a child that inherits the terminal gets every keystroke */
  pause: () => void
  resume: () => void
  /** put the terminal back the way it was found; nothing to do for a non-tty io */
  close?: () => void
}

// Bracketed paste, DECSET 2004. A pasted block is many lines to the tty, so konvoy read it as
// many messages and sent one turn per line: the first fragment went to the agent while the rest
// queued behind it. With the mode on, the terminal brackets the block and konvoy can tell a
// paste from typing. A terminal that does not support it never sends the markers and konvoy
// behaves exactly as before, one turn per line.
export const PASTE_ON = '\x1b[?2004h'
export const PASTE_OFF = '\x1b[?2004l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export interface MessageSplitter {
  /** every complete message in what has arrived so far */
  push: (text: string) => string[]
  /** whatever is left at end of input, terminated or not */
  end: () => string[]
}

export function messageSplitter(): MessageSplitter {
  let buffered = ''
  // non-null only while inside a bracketed paste, so '' is a started-but-empty paste
  let pasted: string | null = null

  const close = (tail: string): string => `${pasted}${tail}`.replace(/\r\n?/g, '\n').replace(/\n+$/, '')

  return {
    push(text) {
      buffered += text
      const out: string[] = []
      for (;;) {
        if (pasted !== null) {
          const at = buffered.indexOf(PASTE_END)
          if (at === -1) {
            // hold back what could still be the head of a split end marker
            const keep = Math.min(PASTE_END.length - 1, buffered.length)
            pasted += buffered.slice(0, buffered.length - keep)
            buffered = buffered.slice(buffered.length - keep)
            break
          }
          out.push(close(buffered.slice(0, at)))
          pasted = null
          buffered = buffered.slice(at + PASTE_END.length)
          // the Return that usually follows a paste is the paste's own terminator, not an
          // empty message of its own
          if (buffered.startsWith('\n')) buffered = buffered.slice(1)
          continue
        }

        const start = buffered.indexOf(PASTE_START)
        const newline = buffered.indexOf('\n')
        if (start !== -1 && (newline === -1 || start < newline)) {
          // anything typed before the paste on the same line belongs to the same message
          pasted = buffered.slice(0, start)
          buffered = buffered.slice(start + PASTE_START.length)
          continue
        }
        if (newline === -1) break
        out.push(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
      }
      return out
    },
    end() {
      const rest = pasted !== null ? close(buffered) : buffered
      pasted = null
      buffered = ''
      return rest === '' ? [] : [rest]
    },
  }
}

/** the part of process.stdin the REPL uses, so a test can drive it without a real terminal */
export interface InputStream {
  on: (event: 'data' | 'end', handler: (chunk: Uint8Array) => void) => void
  pause: () => void
  resume: () => void
  isTTY?: boolean | undefined
}

export function terminalIo(
  stream: InputStream = process.stdin,
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
): ReplIo {
  const queue: string[] = []
  const decoder = new TextDecoder()
  const split = messageSplitter()
  const tty = Boolean(stream.isTTY)
  let ended = false
  let wake: (() => void) | undefined
  const flush = (): void => {
    wake?.()
    wake = undefined
  }
  stream.on('data', (chunk: Uint8Array) => {
    for (const message of split.push(decoder.decode(chunk, { stream: true }))) queue.push(message)
    flush()
  })
  stream.on('end', () => {
    for (const message of split.end()) queue.push(message)
    ended = true
    flush()
  })
  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      if (queue.length > 0) yield queue.shift()!
      else if (ended) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  // a konvoy killed by a signal must not leave the mode on in the user's shell
  let forget: (() => void) | undefined
  if (tty) {
    write(PASTE_ON)
    forget = onExit(() => write(PASTE_OFF))
  }
  return {
    lines: lines(),
    write,
    tty,
    color: colorEnabled(Bun.env, tty),
    pause: () => stream.pause(),
    resume: () => stream.resume(),
    close: () => {
      if (!tty) return
      write(PASTE_OFF)
      forget?.()
      forget = undefined
    },
  }
}

/** runs one command line through the command table, as `konvoy <tokens>` would, for the given session */
export type Run = (tokens: string[], slug: string) => Promise<number> | number

// The commands that exist only inside the REPL. They render through the same two-column helper
// as the table ones, on one shared width, so `/help` reads as a single list.
const INNER: readonly CommandRow[] = [
  { usage: 'use <agent>', summary: 'talk to this agent from now on' },
  { usage: 'goal <text>', summary: 'set the session goal' },
  { usage: 'help', summary: 'this list' },
  { usage: 'quit', summary: 'leave (Ctrl-D does too)' },
]

export const replHelp = (): string => `${formatRows('/', [...INNER, ...commandTable])}\n`

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
  const p = palette(io.color ?? false)
  const paintAgent = agentPaint(io.color ?? false)
  // The slug is in the banner and in `/roster`; repeating it on every line is noise, and a
  // prompt reading "test claude>" is mostly punctuation and bookkeeping. What changes turn to
  // turn is which agent is listening, so that is what the prompt carries.
  // The session total is only worth printing when it has changed, which is after a turn and not
  // after `/help`: a line that reprints itself every prompt is another thing scrolling past.
  let lastStatus = ''
  const prompt = (): void => {
    if (!io.tty) return
    const status = statusLine(session.slug, usageForSession(db, session.id), io.color ?? false)
    if (status !== '' && status !== lastStatus) {
      io.write(`${status}\n`)
      lastStatus = status
    }
    io.write(`${paintAgent(agent)(agent)} ${p.dim('›')} `)
  }
  const refresh = (): boolean => {
    const fresh = listSessions(db).find((s) => s.id === session.id)
    if (fresh) session = fresh
    return fresh !== undefined
  }

  const exec = async (tokens: string[]): Promise<void> => {
    io.pause()
    try {
      await run(tokens, session.slug)
    } finally {
      io.resume()
    }
  }

  prompt()
  for await (const raw of io.lines) {
    const line = raw.trim()
    if (line === '') {
      prompt()
      continue
    }
    if (!line.startsWith('/')) {
      await exec(['send', agent, line])
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
      const next = requireAgent(rest[0] ?? '')
      if (next && !resolveAgent(cfg, next).enabled) {
        console.error(disabledAgent(next))
      } else if (next) {
        agent = next
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
        await exec(['rename', session.slug, rest.join(' ')])
        refresh()
      }
    } else if (cmd === 'attach') {
      await exec(['attach', rest[0] ?? agent, ...rest.slice(1)])
    } else {
      await exec([cmd, ...rest])
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
