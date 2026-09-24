import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { effortSchema } from '../config/schema'
import type { AgentId, Effort, Session } from '../types'
import { onExit } from '../core/children'
import { requireAgent, unknownAgent } from './messages'
import { disabledAgent, MODEL_PATTERN, resolveAgent } from '../config/load'
import { agentPaint, colorEnabled, colorLevel, palette, type ColorLevel } from '../style'
import { statusLine, tokens } from '../render'
import { sessionDir } from '../paths'
import { agentIds } from '../config/schema'
import {
  currentSession,
  getSessionById,
  getSessionBySlug,
  lastTurnAgent,
  listSessions,
  lastAskedPrompt,
  setGoal,
  usageForSession,
} from '../store/queries'
import { cmdNew } from './new'
import { commandTable, formatRows, resolveCommandName, type CommandRow } from './table'
import type { Completion, EditorIo, MenuItem, PromptSpec } from '../editor'
import { stringWidth } from '../term'

export interface ReplIo {
  lines: AsyncIterable<string>
  write: (text: string) => void
  tty: boolean
  /** whether this io may carry colour, decided once from the environment by terminalIo */
  color?: boolean | ColorLevel
  /** stop reading stdin while a command runs, so a child that inherits the terminal gets every keystroke */
  pause: () => void
  resume: () => void
  /** put the terminal back the way it was found; nothing to do for a non-tty io */
  close?: () => void
  /**
   * a person at a raw-mode terminal: the editor draws the prompt and reads the line, and a turn
   * runs with the keyboard watched for an interrupt. Absent, lines are read as they arrive
   */
  editor?: EditorIo
  /** terminal width, for the footer and the popup */
  columns?: () => number
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

/** anything a command run from the REPL needs beyond its words */
export interface RunExtras {
  /** the turn's interrupt, when the editor is watching the keyboard for one */
  signal?: AbortSignal
  /** the configuration with this REPL's /model and /effort applied */
  cfg?: Config
}

/** runs one command line through the command table, as `konvoy <tokens>` would, for the given session */
export type Run = (tokens: string[], slug: string, extras?: RunExtras) => Promise<number> | number

// The commands that exist only inside the REPL. They render through the same two-column helper
// as the table ones, on one shared width, so `/help` reads as a single list.
const INNER: readonly CommandRow[] = [
  { usage: 'use <agent>', summary: 'talk to this agent from now on (shift+tab cycles)' },
  { usage: 'model [name]', summary: "the current agent's model, until you leave" },
  { usage: 'effort [level]', summary: "the current agent's effort, until you leave" },
  { usage: 'retry [agent]', summary: 'send the last prompt again, to this agent or another' },
  { usage: 'goal <text>', summary: 'set the session goal' },
  { usage: 'clear', summary: 'clear the screen' },
  { usage: 'help', summary: 'this list' },
  { usage: 'quit', summary: 'leave (Ctrl-D does too)' },
]

// The keys and prefixes, shown under /help and in the panel `?` opens.
export const SHORTCUTS: readonly [string, string][] = [
  ['/', 'commands'],
  ['@agent <msg>', 'ask another agent once, without switching'],
  ['!<command>', 'run a shell command in the session directory'],
  ['shift+tab', 'switch to the next agent'],
  ['\\⏎  alt+⏎  ctrl+j', 'a new line'],
  ['↑ ↓', 'history'],
  ['ctrl+r', 'search history'],
  ['esc', 'interrupt a turn; twice clears the line'],
  ['ctrl+c', 'clear the line; twice exits'],
  ['ctrl+d', 'exit'],
  ['ctrl+l', 'clear the screen'],
]

export const replHelp = (): string => {
  const width = Math.max(...SHORTCUTS.map(([k]) => stringWidth(k)))
  const keys = SHORTCUTS.map(([k, v]) => `  ${k}${' '.repeat(width - stringWidth(k))}  ${v}`).join('\n')
  return `${formatRows('/', [...INNER, ...commandTable])}\n\n${keys}\n`
}

export async function startSession(
  db: Database,
  cfg: Config,
  cwd: string,
  slug?: string,
  opts: { quiet?: boolean } = {},
): Promise<Session | null> {
  if (slug) return getSessionBySlug(db, slug)
  const current = currentSession(db, cwd)
  if (current) return current
  if ((await cmdNew(db, cfg, cwd, '', { quiet: opts.quiet })) !== 0) return null
  return currentSession(db, cwd)
}

// The REPL's own words, in the order they are completed: its inner commands, then the table's.
function slashItems(): MenuItem[] {
  const items: MenuItem[] = []
  const seen = new Set<string>()
  const add = (name: string, usage: string, summary: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    // a command whose usage names no required argument runs as soon as it is picked
    const required = usage.replace(/\[[^\]]*\]/g, '').includes('<')
    items.push({ label: `/${usage}`, insert: `/${name}`, detail: summary, run: !required })
  }
  for (const row of INNER) add(row.usage.split(' ')[0]!, row.usage, row.summary)
  for (const c of commandTable) add(c.name, c.usage, c.summary)
  return items
}

const EFFORTS = effortSchema.options

export interface ReplOptions {
  /** the configuration of another directory, for a session resumed from one */
  loadConfig?: (cwd: string) => Promise<Config>
}

export async function runRepl(
  io: ReplIo,
  db: Database,
  cfg: Config,
  cwd: string,
  start: Session,
  run: Run,
  options: ReplOptions = {},
): Promise<number> {
  let session = start
  // the agent the person was last talking to, when this session has one: a REPL reopened on a
  // session picks the conversation up where it stood, not at its lead
  const last = lastTurnAgent(db, session.id)
  let agent: AgentId = last && resolveAgent(cfg, last).enabled ? last : session.lead
  const p = palette(io.color ?? false)
  const paintAgent = agentPaint(io.color ?? false)
  // /model and /effort hold for this REPL, over whatever the configuration says
  const overrides = new Map<AgentId, { model?: string; effort?: Effort }>()
  const effective = (): Config => {
    if (overrides.size === 0) return cfg
    const agents = { ...cfg.agents }
    for (const [id, o] of overrides) agents[id] = { ...(agents[id] ?? {}), ...o }
    return { ...cfg, agents }
  }

  // The slug is in the banner and in `/roster`; repeating it on every line is noise, and a
  // prompt reading "test claude>" is mostly punctuation and bookkeeping. What changes turn to
  // turn is which agent is listening, so that is what the prompt carries.
  // The session total is only worth printing when it has changed, which is after a turn and not
  // after `/help`: a line that reprints itself every prompt is another thing scrolling past.
  let lastStatus = ''
  const prompt = (): void => {
    if (io.editor) return
    if (!io.tty) return
    const status = statusLine(session.slug, usageForSession(db, session.id), io.color ?? false)
    if (status !== '' && status !== lastStatus) {
      io.write(`${status}\n`)
      lastStatus = status
    }
    io.write(`${paintAgent(agent)(agent)} ${p.dim('›')} `)
  }
  const refresh = (): boolean => {
    const fresh = getSessionById(db, session.id)
    if (fresh) session = fresh
    return fresh !== null
  }
  const moveTo = async (next: Session): Promise<void> => {
    if (next.cwd !== session.cwd && options.loadConfig) cfg = await options.loadConfig(next.cwd)
    session = next
    const lastAgent = lastTurnAgent(db, next.id)
    agent = lastAgent && resolveAgent(cfg, lastAgent).enabled ? lastAgent : next.lead
  }

  // Everything but a turn runs with the terminal handed over and stdin left alone, which an
  // attached TUI or a shell needs: the child gets every keystroke.
  const handOver = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (io.editor) return io.editor.suspend(fn)
    io.pause()
    try {
      return await fn()
    } finally {
      io.resume()
    }
  }
  // A turn runs with the keyboard watched, so Esc stops the agent and not konvoy.
  const exec = async (tokens: string[], mode: 'turn' | 'plain' = 'plain'): Promise<void> => {
    const extras = overrides.size > 0 ? { cfg: effective() } : undefined
    if (io.editor && mode === 'turn') {
      await io.editor.busy((signal) => Promise.resolve(run(tokens, session.slug, { ...extras, signal })))
      return
    }
    await handOver(() => Promise.resolve(run(tokens, session.slug, extras)))
  }

  const say = (text: string): void => {
    if (io.tty) console.error(p.dim(text))
    else console.error(text)
  }

  const turn = async (to: AgentId, text: string, follow: boolean): Promise<void> => {
    // after `--`: a message that starts with a dash is the person's words, not a flag
    await exec(['send', to, '--', text], 'turn')
    // failover never falls back, so the agent that answered is the one to keep talking to
    const moved = lastTurnAgent(db, session.id)
    if (follow && moved && moved !== agent) agent = moved
    if (io.editor) io.write('\n')
  }

  const iterator = io.lines[Symbol.asyncIterator]()
  const next = async (): Promise<string | null> => {
    if (io.editor) return io.editor.read(() => promptSpec())
    const r = await iterator.next()
    return r.done ? null : r.value
  }

  const promptSpec = (): PromptSpec => {
    const settings = resolveAgent(effective(), agent)
    const rows = usageForSession(db, session.id)
    const turns = rows.reduce((n, r) => n + r.turns, 0)
    const input = rows.reduce((n, r) => n + r.inputTokens, 0)
    const usd = rows.reduce((n, r) => n + r.costUsd, 0)
    const credits = rows.reduce((n, r) => n + r.credits, 0)
    const left = [session.slug]
    if (turns > 0) left.push(`${turns} turn${turns === 1 ? '' : 's'}`, `${tokens(input)} in`)
    if (usd > 0) left.push(`$${usd.toFixed(2)}`)
    if (credits > 0) left.push(`${credits.toFixed(2)} cr`)
    const right = [settings.model, settings.effort, settings.permission].filter(Boolean).join(' · ')
    return {
      prompt: `${paintAgent(agent)(agent)} ${p.dim('›')} `,
      placeholder: `ask ${agent} anything  ·  / commands  ·  @ another agent  ·  ! shell  ·  ? shortcuts`,
      footer: [p.dim(`  ${left.join(' · ')}`), p.dim(`${right}  `)],
      paint: { dim: p.dim, accent: paintAgent(agent), inverse: p.inverse, bold: p.bold, yellow: p.yellow },
      shortcuts: SHORTCUTS,
      highlight: (word, first) => {
        if (first && word.startsWith('/') && resolveSlash(word.slice(1))) return p.bold
        if (word.startsWith('@') && (agentIds as readonly string[]).includes(word.slice(1))) return paintAgent(word.slice(1))
        return null
      },
    }
  }

  // shift+tab: the next agent that is enabled, in roster order
  const cycle = (): void => {
    const enabled = agentIds.filter((a) => resolveAgent(cfg, a).enabled)
    if (enabled.length === 0) return
    agent = enabled[(enabled.indexOf(agent) + 1) % enabled.length]!
  }
  if (io.editor) io.editor.onCycle = cycle

  prompt()
  for (;;) {
    const raw = await next()
    if (raw === null) break
    const line = raw.trim()
    if (line === '') {
      prompt()
      continue
    }

    // `@codex review this` asks codex once and keeps talking to the current agent
    const mention = /^@([a-z]+)(?:\s+([\s\S]*))?$/.exec(line)
    if (mention) {
      const to = requireAgent(mention[1]!)
      if (to && !resolveAgent(cfg, to).enabled) console.error(disabledAgent(to))
      else if (to && mention[2]?.trim()) await turn(to, mention[2].trim(), false)
      else if (to) agent = to
      prompt()
      continue
    }

    // `!git status` runs in the session's directory, with the terminal handed over to it
    if (line.startsWith('!')) {
      const command = line.slice(1).trim()
      if (command === '') console.error('usage: !<command>')
      else await shell(handOver, command, session.cwd, say)
      prompt()
      continue
    }

    if (!line.startsWith('/')) {
      await turn(agent, line, true)
      prompt()
      continue
    }

    const [cmd = '', ...rest] = line.slice(1).split(/\s+/)
    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') break
    if (cmd === 'help' || cmd === '?') {
      io.write(replHelp())
    } else if (cmd === 'use') {
      if (!rest[0]) {
        say(`talking to ${agent} - /use <agent> to switch: ${agentIds.join(', ')}`)
      } else {
        const next = requireAgent(rest[0] ?? '')
        if (next && !resolveAgent(cfg, next).enabled) {
          console.error(disabledAgent(next))
        } else if (next) {
          agent = next
        }
      }
    } else if (cmd === 'model') {
      const value = rest[0]
      if (!value) {
        say(`${agent} runs ${resolveAgent(effective(), agent).model ?? 'its own default model'} - /model <name> to change it, /model default to go back`)
      } else if (value === 'default' || value === '-') {
        const o = overrides.get(agent)
        if (o) {
          delete o.model
          if (o.effort === undefined) overrides.delete(agent)
        }
        say(`${agent} is back on ${resolveAgent(effective(), agent).model ?? 'its own default model'}`)
      } else if (!MODEL_PATTERN.test(value)) {
        console.error(`"${value}" is not a model name konvoy will pass to a command line`)
      } else {
        overrides.set(agent, { ...(overrides.get(agent) ?? {}), model: value })
        say(`${agent} runs ${value} until you leave`)
      }
    } else if (cmd === 'effort') {
      const value = rest[0]
      if (!value) {
        say(`${agent} thinks at ${resolveAgent(effective(), agent).effort} - /effort ${EFFORTS.join('|')}`)
      } else if (!(EFFORTS as readonly string[]).includes(value)) {
        console.error(`effort is one of ${EFFORTS.join(', ')}`)
      } else {
        overrides.set(agent, { ...(overrides.get(agent) ?? {}), effort: value as Effort })
        say(`${agent} thinks at ${value} until you leave`)
      }
    } else if (cmd === 'retry') {
      const previous = lastAskedPrompt(db, session.id)
      const to = rest[0] ? requireAgent(rest[0]) : agent
      if (previous === null) console.error(`session ${session.slug} has no turn to retry`)
      else if (to && !resolveAgent(cfg, to).enabled) console.error(disabledAgent(to))
      else if (to) await turn(to, previous, to === agent)
    } else if (cmd === 'clear') {
      if (io.editor) io.editor.clearScreen()
      else if (io.tty) io.write('\x1b[H\x1b[2J')
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
        if (target) await moveTo(target)
      } else if (cmd === 'new' || cmd === 'start') {
        const created = currentSession(db, cwd)
        if (created && created.id !== session.id) await moveTo(created)
      } else if (!refresh()) {
        console.error(`session ${session.slug} is gone`)
        return 0
      }
    }
    prompt()
  }
  if (io.tty && !io.editor) io.write('\n')
  return 0
}

// the table's word for what was typed, or an inner command's
function resolveSlash(word: string): boolean {
  return resolveCommandName(word) !== undefined || INNER.some((r) => r.usage.split(' ')[0] === word) || word === 'exit' || word === 'q'
}

async function shell(
  handOver: (fn: () => Promise<number>) => Promise<number>,
  command: string,
  cwd: string,
  say: (text: string) => void,
): Promise<void> {
  const code = await handOver(async () => {
    try {
      const proc = Bun.spawn([Bun.env.SHELL || '/bin/sh', '-c', command], { cwd, stdio: ['inherit', 'inherit', 'inherit'] })
      return await proc.exited
    } catch (error) {
      console.error(`could not run ${command}: ${error instanceof Error ? error.message : String(error)}`)
      return 127
    }
  })
  if (code !== 0) say(`  exit ${code}`)
}

/**
 * what the popup offers for the word under the cursor: commands after a leading `/`, agents after
 * `@` and after the commands that take one, sessions after `/resume` and `/rm`
 */
export function replCompleter(db: Database, cfg: () => Config): (buffer: string, cursor: number) => Completion | null {
  const commands = slashItems()
  const agentItems = (): MenuItem[] =>
    agentIds.map((a) => ({ label: a, insert: a, detail: resolveAgent(cfg(), a).enabled ? (resolveAgent(cfg(), a).model ?? '') : 'disabled' }))
  const rank = <T extends { insert: string }>(items: T[], typed: string): T[] => {
    const lower = typed.toLowerCase()
    const prefix = items.filter((i) => i.insert.toLowerCase().startsWith(lower))
    const inside = items.filter((i) => !i.insert.toLowerCase().startsWith(lower) && i.insert.toLowerCase().includes(lower.replace(/^[/@]/, '')))
    return [...prefix, ...inside]
  }

  return (buffer, cursor) => {
    const before = buffer.slice(0, cursor)
    if (before.includes('\n')) return null
    // the first word
    if (/^\/\S*$/.test(before)) {
      const items = rank(commands, before)
      return items.length > 0 ? { start: 0, items } : null
    }
    if (/^@\S*$/.test(before)) {
      const items = rank(agentItems().map((a) => ({ ...a, label: `@${a.label}`, insert: `@${a.insert}` })), before)
      return items.length > 0 ? { start: 0, items } : null
    }
    // the second word of a command that takes an agent, a session or a level
    const second = /^\/(\S+)\s+(\S*)$/.exec(before)
    if (!second) return null
    const [, cmd, typed] = second as unknown as [string, string, string]
    const start = before.length - typed.length
    let items: MenuItem[] = []
    if (['use', 'attach', 'send', 'retry'].includes(cmd)) items = agentItems()
    else if (['resume', 'rm'].includes(cmd)) items = listSessions(db).map((s) => ({ label: s.slug, insert: s.slug, detail: s.goal }))
    else if (cmd === 'effort') items = EFFORTS.map((e) => ({ label: e, insert: e }))
    else if (cmd === 'config') items = ['get', 'set', 'unset', 'path'].map((e) => ({ label: e, insert: e }))
    else if (cmd === 'completion') items = ['bash', 'zsh', 'fish'].map((e) => ({ label: e, insert: e }))
    // one word is all these take, so the word that completes them completes the command
    const runs = ['use', 'effort', 'resume', 'attach', 'retry', 'completion'].includes(cmd)
    const ranked = rank(items, typed).map((i) => (runs ? { ...i, run: true } : i))
    return ranked.length > 0 ? { start, items: ranked } : null
  }
}

/** the colour depth an editor-driven REPL draws with, decided once from the terminal */
export const replColor = (): ColorLevel => colorLevel(Bun.env, Boolean(process.stdout.isTTY))

export { unknownAgent }
