import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { effortSchema, permissionSchema } from '../config/schema'
import type { AgentId, Effort, Permission, Session } from '../types'
import { onExit } from '../core/children'
import { requireAgent, unknownAgent } from './messages'
import { disabledAgent, MODEL_PATTERN, resolveAgent } from '../config/load'
import { agentPaint, colorEnabled, colorLevel, palette, type ColorLevel } from '../style'
import { statusLine, tokens } from '../render'
import { sessionDir } from '../paths'
import { agentIds } from '../config/schema'
import {
  currentSession,
  getBinding,
  getSessionById,
  getSessionBySlug,
  lastTurnAgent,
  listSessions,
  lastAskedPrompt,
  recentTurns,
  setGoal,
  usageForSession,
} from '../store/queries'
import { detect } from '../core/detect'
import { listModels, nearestModels, realCatalogDeps, type Catalog } from '../core/models'
import { unseenTurns } from '../core/prelude'
import { configKey } from '../config/keys'
import {
  agentChoices,
  configKeyChoices,
  configValueChoices,
  effortChoices,
  KONVOY,
  modelChoices,
  permissionChoices,
  scopeChoices,
  sessionChoices,
} from './choices'
import { cmdNew } from './new'
import { commandHelp, commandTable, formatRows, resolveCommandName, type CommandRow } from './table'
import type { Completion, EditorIo, MenuItem, PickSpec, PromptSpec } from '../editor'
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
  /** a list to choose from, where the editor would draw one; a test scripts its answers here */
  pick?: (spec: PickSpec) => Promise<string | null>
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
  { usage: 'use [agent|konvoy]', summary: 'talk to this agent from now on, or let konvoy route (shift+tab cycles)' },
  { usage: 'model [name]', summary: "the current agent's model, until you leave; alone, the list to pick from" },
  { usage: 'effort [level]', summary: "the current agent's effort, until you leave" },
  { usage: 'permission [level]', summary: 'what the current agent may do without asking, until you leave' },
  { usage: 'retry [agent]', summary: 'send the last prompt again, to this agent or another' },
  { usage: 'goal <text>', summary: 'set the session goal' },
  { usage: 'clear', summary: 'clear the screen' },
  { usage: 'quit', summary: 'leave (Ctrl-D does too)' },
]

// The keys and prefixes, shown under /help and in the panel `?` opens.
export const SHORTCUTS: readonly [string, string][] = [
  ['/', 'commands'],
  ['@agent <msg>', 'ask another agent once, without switching'],
  ['!<command>', 'run a shell command in the session directory'],
  ['shift+tab', 'the next agent, or konvoy mode'],
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
const PERMISSIONS = permissionSchema.options

/** the agent a REPL opens on: whoever answered last, when still enabled, or the session's lead */
export function startingAgent(db: Database, cfg: Config, session: Session): AgentId {
  const last = lastTurnAgent(db, session.id)
  return last && resolveAgent(cfg, last).enabled ? last : session.lead
}

export interface ReplOptions {
  /** the configuration of another directory, for a session resumed from one */
  loadConfig?: (cwd: string) => Promise<Config>
  /** the models an agent will run, for `/model`; asked of the CLI by default */
  models?: (agent: AgentId, bin?: string) => Promise<Catalog | null>
  /** the efforts an agent's model supports, when konvoy can tell */
  efforts?: (agent: AgentId, model?: string, bin?: string) => Promise<readonly string[] | undefined>
  /** the agents found installed when the REPL opened: konvoy mode routes among these */
  installed?: ReadonlySet<AgentId>
}

/** what a REPL holds over the configuration until it is left: `/model`, `/effort`, `/permission` */
interface Override {
  model?: string
  effort?: Effort
  permission?: Permission
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
  let agent: AgentId = startingAgent(db, cfg, session)
  // konvoy mode: konvoy, not one agent, is listening. Each prompt goes to the agent that answered
  // last (the lead at first), and when that one is rate-limited, signed out or its upstream is
  // down, the next ready agent takes it - the order shown in the footer. The agent it lands on is
  // the one the next prompt starts with, so a limit that resets does not pull the session back.
  let konvoyMode = false
  const p = palette(io.color ?? false)
  const paintAgent = agentPaint(io.color ?? false)
  const overrides = new Map<AgentId, Override>()
  const enabled = (a: AgentId): boolean => resolveAgent(cfg, a).enabled

  // the order konvoy mode tries: a failover chain the config names, else every ready agent, in
  // roster order, starting from the one listening now; signed-out agents go last
  const route = (): AgentId[] => {
    const named = cfg.failover.chain.filter(enabled)
    const pool = (named.length > 0 ? named : [...agentIds]).filter((a) => enabled(a) && (options.installed?.has(a) ?? true))
    const signedOut = (a: AgentId): boolean => getBinding(db, session.id, a)?.status === 'auth_required'
    const rest = pool.filter((a) => a !== agent)
    return [agent, ...rest.filter((a) => !signedOut(a)), ...rest.filter(signedOut)]
  }
  const effective = (routed = false): Config => {
    if (overrides.size === 0 && !routed) return cfg
    const agents = { ...cfg.agents }
    for (const [id, o] of overrides) agents[id] = { ...(agents[id] ?? {}), ...o }
    return routed ? { ...cfg, agents, failover: { ...cfg.failover, chain: route() } } : { ...cfg, agents }
  }
  const setOverride = (a: AgentId, patch: Override): void => {
    overrides.set(a, { ...(overrides.get(a) ?? {}), ...patch })
  }
  const clearOverride = (a: AgentId, key: keyof Override): void => {
    const o = overrides.get(a)
    if (!o) return
    delete o[key]
    if (Object.keys(o).length === 0) overrides.delete(a)
  }

  // The slug is in the banner and in `/roster`; repeating it on every line is noise, and a
  // prompt reading "test claude>" is mostly punctuation and bookkeeping. What changes turn to
  // turn is which agent is listening, so that is what the prompt carries.
  // The session total is only worth printing when it has changed, which is after a turn and not
  // after `/help`: a line that reprints itself every prompt is another thing scrolling past.
  let lastStatus = ''
  const label = (): string => (konvoyMode ? 'konvoy' : agent)
  const prompt = (): void => {
    if (io.editor) return
    if (!io.tty) return
    const status = statusLine(session.slug, usageForSession(db, session.id), io.color ?? false)
    if (status !== '' && status !== lastStatus) {
      io.write(`${status}\n`)
      lastStatus = status
    }
    io.write(`${paintAgent(label())(label())} ${p.dim('›')} `)
  }
  const refresh = (): boolean => {
    const fresh = getSessionById(db, session.id)
    if (fresh) session = fresh
    return fresh !== null
  }
  const moveTo = async (next: Session): Promise<void> => {
    if (next.cwd !== session.cwd && options.loadConfig) cfg = await options.loadConfig(next.cwd)
    session = next
    agent = startingAgent(db, cfg, next)
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
  const exec = async (tokens: string[], mode: 'turn' | 'plain' = 'plain', routed = false): Promise<void> => {
    const extras = overrides.size > 0 || routed ? { cfg: effective(routed) } : undefined
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
    // after `--`: a message that starts with a dash is the person's words, not a flag. konvoy mode
    // routes the person's own prompts; an `@agent` question goes to that agent alone.
    await exec(['send', to, '--', text], 'turn', konvoyMode && follow)
    // failover never falls back, so the agent that answered is the one to keep talking to
    const moved = lastTurnAgent(db, session.id)
    if (follow && moved && moved !== agent) agent = moved
    if (io.editor) io.write('\n')
  }

  // A list to choose from. With nobody at a terminal to point at one, the list is printed with
  // the word that picks from it, and nothing is chosen.
  const choose = async (spec: PickSpec): Promise<string | null> => {
    if (io.pick) return io.pick(spec)
    if (io.editor) return io.editor.pick(spec, { dim: p.dim, accent: paintAgent(label()), bold: p.bold })
    const rows = spec.items.map((i) => `  ${i.label}${i.current ? ' ✔' : ''}${i.detail ? `  ${i.detail}` : ''}${i.disabled ? `  (${i.disabled})` : ''}`)
    io.write(`${spec.title}${spec.subtitle ? ` - ${spec.subtitle}` : ''}\n${rows.join('\n')}\n`)
    return null
  }

  // what each CLI will run, asked once per REPL: a CLI takes a second or two to list them
  const catalogs = new Map<string, Promise<Catalog | null>>()
  const catalogFor = async (a: AgentId): Promise<Catalog | null> => {
    const bin = resolveAgent(cfg, a).bin
    const key = `${a}:${bin ?? ''}`
    let pending = catalogs.get(key)
    const fresh = !pending
    if (!pending) {
      pending = (options.models ?? ((x: AgentId, b?: string) => listModels(x, realCatalogDeps(), b)))(a, bin)
      catalogs.set(key, pending)
    }
    if (!fresh || !io.editor) return pending
    io.write(`${p.dim(`  asking ${a} for its models…`)}\n`)
    try {
      return await pending
    } finally {
      io.write('\x1b[1A\r\x1b[2K')
    }
  }
  const effortsFor = (a: AgentId): Promise<readonly string[] | undefined> => {
    const s = resolveAgent(effective(), a)
    return options.efforts ? options.efforts(a, s.model, s.bin) : detect(a, { model: s.model, bin: s.bin }).then((d) => d.efforts)
  }

  const setModel = async (value: string, typed: boolean): Promise<void> => {
    if (value === 'default' || value === '-') {
      clearOverride(agent, 'model')
      say(`${agent} is back on ${resolveAgent(effective(), agent).model ?? 'its own default model'}`)
      return
    }
    if (!MODEL_PATTERN.test(value)) {
      console.error(`"${value}" is not a model name konvoy will pass to a command line`)
      return
    }
    if (typed) {
      // a name the CLI's own list lacks is refused here, not by the turn it would fail
      const catalog = await catalogFor(agent)
      if (catalog?.complete && !catalog.models.some((m) => m.id === value)) {
        const near = nearestModels(value, catalog)
        console.error(`"${value}" is not a model ${agent} offers${near.length > 0 ? ` - did you mean ${near.join(' or ')}?` : ''} /model lists them`)
        return
      }
    }
    setOverride(agent, { model: value })
    say(`${agent} runs ${value} until you leave`)
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
    // the shared context made visible: what the agent listening now will be caught up on
    const behind = turns > 0 ? unseenTurns(db, session, agent) : 0
    if (behind > 0) left.push(`${agent} is ${behind} turn${behind === 1 ? '' : 's'} behind`)
    // who is listening, bottom right, the way the agents' own CLIs show their mode
    const tuned = [settings.model, settings.effort, settings.permission].filter(Boolean).join(' · ')
    const who = konvoyMode
      ? `${paintAgent('konvoy')('✻ konvoy')} ${p.dim(`→ ${route().join(' › ')}`)}`
      : `${paintAgent(agent)('●')} ${agent} ${p.dim(`· ${tuned}`)}`
    const width = io.columns?.() ?? 80
    const hint = p.dim('  ⇧⇥ switch')
    const room = width - 2 - stringWidth(`  ${left.join(' · ')}`)
    const right = stringWidth(who) + stringWidth(hint) + 2 <= room ? `${who}${hint}  ` : `${who}  `
    return {
      prompt: `${paintAgent(label())(label())} ${p.dim('›')} `,
      placeholder: konvoyMode
        ? 'ask anything - konvoy routes it  ·  / commands  ·  @ one agent  ·  ! shell  ·  ? shortcuts'
        : `ask ${agent} anything  ·  / commands  ·  @ another agent  ·  ! shell  ·  ? shortcuts`,
      footer: [p.dim(`  ${left.join(' · ')}`), right],
      paint: { dim: p.dim, accent: paintAgent(label()), bold: p.bold, yellow: p.yellow },
      shortcuts: SHORTCUTS,
      highlight: (word, first) => {
        if (first && word.startsWith('/') && resolveSlash(word.slice(1))) return p.bold
        if (word.startsWith('@') && (agentIds as readonly string[]).includes(word.slice(1))) return paintAgent(word.slice(1))
        return null
      },
    }
  }

  // shift+tab: konvoy mode, then each agent that can answer, in roster order, and round again -
  // one that is not installed is a stop that only fails
  const cycle = (): void => {
    const stops: (AgentId | typeof KONVOY)[] = [KONVOY, ...agentIds.filter((a) => enabled(a) && (options.installed?.has(a) ?? true))]
    const at = stops.indexOf(konvoyMode ? KONVOY : agent)
    const to = stops[(at + 1) % stops.length]!
    if (to === KONVOY) konvoyMode = true
    else {
      konvoyMode = false
      agent = to
    }
  }
  if (io.editor) io.editor.onCycle = cycle

  const useAgent = (word: string): void => {
    if (word === KONVOY) {
      konvoyMode = true
      return
    }
    const to = requireAgent(word)
    if (to && !enabled(to)) console.error(disabledAgent(to))
    else if (to) {
      agent = to
      konvoyMode = false
    }
  }

  const configCommand = async (rest: string[]): Promise<void> => {
    const [action, keyWord, ...values] = rest
    const global = rest.includes('--global')
    const words = values.filter((v) => v !== '--global')
    if (!action) {
      await exec(['config', 'get'])
      say('/config set to change a key - it offers every key and its values')
      return
    }
    if (action !== 'set' && action !== 'unset') {
      await exec(['config', ...rest])
      return
    }
    const key = keyWord && keyWord !== '--global' ? keyWord : await choose(configKeyChoices(effective()))
    if (key === null) return
    const known = configKey(key)
    let value: string | null = null
    if (action === 'set') {
      value = words.length > 0 ? words.join(' ') : known ? await choose(configValueChoices(known, effective())) : null
      if (value === null) {
        if (!known) await exec(['config', 'set', key])
        return
      }
    }
    // where it goes: a privileged key only ever to the global file, anything else as asked
    let scope: string | null = global ? 'global' : null
    if (scope === null && known?.privileged) {
      scope = 'global'
      say(`${key} is global only, so it goes to the global config`)
    }
    if (scope === null) scope = known ? await choose(scopeChoices(known)) : 'project'
    if (scope === null) return
    await exec(['config', action, key, ...(value === null ? [] : [value]), ...(scope === 'global' ? ['--global'] : [])])
    // the REPL runs on what the files say now, not on what they said when it opened
    if (options.loadConfig) cfg = await options.loadConfig(session.cwd)
  }

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
      if (to && !enabled(to)) console.error(disabledAgent(to))
      else if (to && mention[2]?.trim()) await turn(to, mention[2].trim(), false)
      else if (to) useAgent(to)
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
      const page = rest[0] ? commandHelp(rest[0].replace(/^\//, ''), '/') : null
      io.write(page ?? replHelp())
    } else if (cmd === 'use') {
      const word =
        rest[0] ??
        (await choose(
          agentChoices(effective(), konvoyMode ? KONVOY : agent, (a) => ({
            installed: options.installed ? options.installed.has(a) : undefined,
            signedOut: getBinding(db, session.id, a)?.status === 'auth_required',
          })),
        ))
      if (word !== null) useAgent(word)
    } else if (cmd === 'model') {
      if (rest[0]) await setModel(rest[0], true)
      else {
        const picked = await choose(modelChoices(agent, await catalogFor(agent), resolveAgent(effective(), agent).model))
        if (picked !== null) await setModel(picked, false)
      }
    } else if (cmd === 'effort') {
      const value = rest[0] ?? (await choose(effortChoices(agent, resolveAgent(effective(), agent).effort, await effortsFor(agent))))
      if (value === null) {
        // nothing chosen, and nothing to say: the list was the answer
      } else if (!(EFFORTS as readonly string[]).includes(value)) {
        console.error(`effort is one of ${EFFORTS.join(', ')}`)
      } else {
        setOverride(agent, { effort: value as Effort })
        say(`${agent} thinks at ${value} until you leave`)
      }
    } else if (cmd === 'permission') {
      const value = rest[0] ?? (await choose(permissionChoices(agent, resolveAgent(effective(), agent).permission)))
      if (value === null) {
        // closed without a choice
      } else if (!(PERMISSIONS as readonly string[]).includes(value)) {
        console.error(`permission is one of ${PERMISSIONS.join(', ')}`)
      } else {
        setOverride(agent, { permission: value as Permission })
        say(`${agent} runs at ${value} until you leave - konvoy config set agents.${agent}.permission ${value} --global keeps it`)
      }
    } else if (cmd === 'retry') {
      const previous = lastAskedPrompt(db, session.id)
      const to = rest[0] ? requireAgent(rest[0]) : agent
      if (previous === null) console.error(`session ${session.slug} has no turn to retry`)
      else if (to && !enabled(to)) console.error(disabledAgent(to))
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
    } else if (cmd === 'config') {
      await configCommand(rest)
    } else if (cmd === 'resume') {
      const now = Date.now()
      const slug =
        rest[0] ??
        (await choose(
          sessionChoices(
            listSessions(db).map((s) => ({
              session: s,
              turns: usageForSession(db, s.id).reduce((n, r) => n + r.turns, 0),
              lastAt: recentTurns(db, s.id, 1)[0]?.startedAt ?? null,
            })),
            session.id,
            now,
          ),
        ))
      if (slug === null) {
        // closed without a choice
      } else if (slug === session.slug) {
        say(`already in ${slug}`)
      } else {
        await exec(['resume', slug])
        const target = getSessionBySlug(db, slug)
        if (target) await moveTo(target)
      }
    } else {
      await exec([cmd, ...rest])
      if (cmd === 'new' || cmd === 'start') {
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
    if (cmd === 'use') items = [{ label: KONVOY, insert: KONVOY, detail: 'konvoy routes: the next agent when one runs out' }, ...agentItems()]
    else if (['attach', 'send', 'retry'].includes(cmd)) items = agentItems()
    else if (['resume', 'rm'].includes(cmd)) items = listSessions(db).map((s) => ({ label: s.slug, insert: s.slug, detail: s.goal }))
    else if (cmd === 'effort') items = EFFORTS.map((e) => ({ label: e, insert: e }))
    else if (cmd === 'permission') items = PERMISSIONS.map((e) => ({ label: e, insert: e }))
    else if (cmd === 'config') items = ['get', 'set', 'unset', 'path'].map((e) => ({ label: e, insert: e }))
    else if (cmd === 'completion') items = ['bash', 'zsh', 'fish'].map((e) => ({ label: e, insert: e }))
    // one word is all these take, so the word that completes them completes the command - and
    // `/config set` alone opens its own list of keys, so it runs as it stands too
    const runs = ['use', 'effort', 'permission', 'resume', 'attach', 'retry', 'completion', 'config'].includes(cmd)
    const ranked = rank(items, typed).map((i) => (runs ? { ...i, run: true } : i))
    return ranked.length > 0 ? { start, items: ranked } : null
  }
}

/** the colour depth an editor-driven REPL draws with, decided once from the terminal */
export const replColor = (): ColorLevel => colorLevel(Bun.env, Boolean(process.stdout.isTTY))

export { unknownAgent }
