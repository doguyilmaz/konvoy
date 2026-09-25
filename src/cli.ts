#!/usr/bin/env bun
import type { Database } from 'bun:sqlite'
import { parseArgs, type Args } from './args'
import { effectiveHarness, loadConfig, resolveAgent } from './config/load'
import { getSessionBySlug, listSessions, recentTurns } from './store/queries'
import { agentIds } from './config/schema'
import type { Config } from './config/schema'
import { openDb } from './store/db'
import { dbPath, sessionDir } from './paths'
import { sessionBanner } from './render'
import { colorLevel } from './style'
import { cmdNew } from './commands/new'
import { cmdSend } from './commands/send'
import { cmdLs } from './commands/ls'
import { cmdRoster } from './commands/roster'
import { cmdStatus } from './commands/status'
import { cmdAttach } from './commands/attach'
import { cmdDoctor } from './commands/doctor'
import { cmdUpdate } from './commands/update'
import { cmdConfig } from './commands/config'
import { cmdResume } from './commands/resume'
import { cmdRm } from './commands/rm'
import { cmdRename } from './commands/rename'
import { cmdUsage } from './commands/usage'
import { cmdDashboard } from './commands/dashboard'
import { cmdLog, cmdShow } from './commands/log'
import { cmdCompletion } from './commands/completion'
import { commandTable, formatRows, resolveCommandName, unknownFlag, type CommandName } from './commands/table'
import { noSessionNamed, requireAgent, unknownCommand } from './commands/messages'
import { replColor, replCompleter, runRepl, startSession, terminalIo, type ReplIo } from './commands/repl'
import { terminalEditor, type RawInput } from './editor'
import { storeHistory, type History } from './history'
import { onExit } from './core/children'
import { locate } from './core/detect'
import { ago, tildify } from './format'
import { oneLine } from './adapters/types'
import { SHOW_CURSOR } from './term'
import type { AgentId } from './types'
import { version as VERSION } from '../package.json'

// Bare `konvoy` is part of the surface, so it is rendered with the commands rather than beside
// them: one call, one column, and the blank line put back after the first row.
const surface = formatRows('konvoy ', [
  { usage: '', summary: "start: resume this directory's session or create one, then talk" },
  ...commandTable,
]).split('\n')

export const USAGE = `konvoy ${VERSION}

${surface[0]!.trimEnd()}

${surface.slice(1).join('\n')}

agents: ${agentIds.join(', ')}
flags:  --session <slug>, --version (-v), --help (-h)
`

interface CommandContext {
  db: Database
  cfg: Config
  cwd: string
  args: Args
  slug: string | undefined
  /** a REPL turn's interrupt, when the editor watches the keyboard */
  signal?: AbortSignal
}

type Handler = (ctx: CommandContext, rest: string[]) => number | Promise<number>

// `-` in a message is standard input, so `git diff | konvoy send claude "review this" -` sends the
// diff with the ask. Read only when asked for: an open terminal on stdin would wait forever.
async function withStdin(prompt: string[]): Promise<string | null> {
  if (!prompt.includes('-')) return prompt.join(' ')
  if (process.stdin.isTTY) return null
  const piped = (await Bun.stdin.text()).replace(/\s+$/, '')
  // the words on either side of a `-` stay one sentence; the piped text is its own paragraph
  const parts: string[] = []
  let words: string[] = []
  for (const word of prompt) {
    if (word !== '-') {
      words.push(word)
      continue
    }
    if (words.length > 0) parts.push(words.join(' '))
    parts.push(piped)
    words = []
  }
  if (words.length > 0) parts.push(words.join(' '))
  return parts.join('\n\n')
}

const flagNumber = (value: string | boolean | undefined): number | undefined =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined

// Every key of CommandName must be handled here - TypeScript's excess/missing property
// checks on an object literal assigned to Record<CommandName, Handler> make an
// undocumented-yet-dispatched or dispatched-yet-undocumented command a compile error.
const handlers: Record<CommandName, Handler> = {
  new: (ctx, rest) => {
    const lead = typeof ctx.args.flags.lead === 'string' ? requireAgent(ctx.args.flags.lead) : undefined
    if (lead === null) return 2
    return cmdNew(ctx.db, ctx.cfg, ctx.cwd, rest.join(' '), lead ? { lead } : {})
  },
  send: async (ctx, rest) => {
    const [agent, ...words] = rest
    if (!agent || words.length === 0) {
      console.error('usage: konvoy send <agent> "<message>"')
      console.error('a message beginning with a dash goes after --, as in: konvoy send codex -- "-1 first"')
      console.error('a lone - reads the message from stdin, as in: git diff | konvoy send claude "review this" -')
      return 2
    }
    const prompt = await withStdin(words)
    if (prompt === null) {
      console.error('konvoy: - reads the message from stdin, and stdin is a terminal - pipe something in')
      return 2
    }
    if (prompt.trim() === '') {
      console.error('konvoy: the message is empty')
      return 2
    }
    return cmdSend(ctx.db, ctx.cfg, ctx.cwd, agent, prompt, ctx.slug, {
      signal: ctx.signal,
      ...(ctx.signal ? { hint: 'esc to interrupt' } : {}),
    })
  },
  ls: (ctx) => cmdLs(ctx.db, ctx.cwd, { json: ctx.args.flags.json === true }),
  roster: (ctx) => cmdRoster(ctx.db, ctx.cfg, ctx.cwd, ctx.slug, { json: ctx.args.flags.json === true }),
  status: (ctx) => cmdStatus(ctx.db, ctx.cfg, ctx.cwd, ctx.slug),
  attach: (ctx, rest) => {
    const [agent] = rest
    if (!agent) {
      console.error('usage: konvoy attach <agent> [--id <session-id>]')
      return 2
    }
    const settings = resolveAgent(ctx.cfg, agent as AgentId)
    const id = typeof ctx.args.flags.id === 'string' ? ctx.args.flags.id : undefined
    return cmdAttach(ctx.db, ctx.cwd, agent, { slug: ctx.slug, bin: settings.bin, id, effort: settings.effort, permission: settings.permission })
  },
  doctor: (ctx) => cmdDoctor(ctx.cfg),
  update: (ctx) => cmdUpdate(ctx.cfg, { all: ctx.args.flags.all === true }),
  resume: (ctx, rest) => cmdResume(ctx.db, ctx.cfg, ctx.cwd, rest[0] ?? ctx.slug),
  log: (ctx) =>
    cmdLog(ctx.db, ctx.cwd, { slug: ctx.slug, limit: flagNumber(ctx.args.flags.limit), json: ctx.args.flags.json === true }),
  show: (ctx, rest) => cmdShow(ctx.db, ctx.cwd, { slug: ctx.slug, which: rest[0] }),
  config: (ctx, rest) => {
    const [action, key, value] = rest
    return cmdConfig(ctx.cfg, ctx.cwd, action ?? 'get', key, value, { global: ctx.args.flags.global === true })
  },
  rename: (ctx, rest) => {
    const [from, to] = rest
    if (!from || !to) {
      console.error('usage: konvoy rename <session> <new-name>')
      return 2
    }
    return cmdRename(ctx.db, from, to)
  },
  rm: (ctx, rest) => {
    const [target] = rest
    if (!target) {
      console.error('usage: konvoy rm <session> --yes')
      return 2
    }
    return cmdRm(ctx.db, ctx.cwd, target, { yes: ctx.args.flags.yes === true })
  },
  usage: (ctx) =>
    cmdUsage(ctx.db, ctx.cfg, ctx.cwd, {
      all: ctx.args.flags.all === true,
      slug: ctx.slug,
      chart: ctx.args.flags.chart === true,
      json: ctx.args.flags.json === true,
    }),
  version: (ctx) => {
    console.log(`konvoy ${VERSION}`)
    return cmdStatus(ctx.db, ctx.cfg, ctx.cwd, ctx.slug, { roster: false })
  },
  dashboard: ({ db, cfg, cwd, args, slug }) => {
    const port = args.flags.port === undefined ? undefined : flagNumber(args.flags.port)
    if (args.flags.port !== undefined && (port === undefined || port > 65535)) {
      console.error(`konvoy: --port takes a number from 0 to 65535, not "${String(args.flags.port)}"`)
      return 2
    }
    return cmdDashboard(db, cfg, cwd, { port, slug, open: args.flags['no-open'] !== true })
  },
  completion: (_ctx, rest) => cmdCompletion(rest[0]),
}

export async function main(argv: string[], io?: ReplIo): Promise<number> {
  const args = parseArgs(argv)
  const [command, ...rest] = args._
  const cwd = process.cwd()
  const slug = typeof args.flags.session === 'string' ? args.flags.session : undefined

  if (args.flags.version === true || args.flags.v === true || args.flags.V === true) {
    console.log(`konvoy ${VERSION}`)
    return 0
  }
  if (command === 'help' || args.flags.help === true || args.flags.h === true) {
    console.log(USAGE)
    return 0
  }
  if (!command) {
    const stray = Object.keys(args.flags).filter((f) => f !== 'session')
    if (stray.length > 0) {
      console.error(`unknown flag ${stray[0]!.length === 1 ? '-' : '--'}${stray[0]}`)
      console.log(USAGE)
      return 2
    }
  }

  if (command === '__complete') return complete(rest[0])
  try {
    return command ? await dispatch(command, rest, cwd, slug, args) : await interactive(io, cwd, slug)
  } catch (error) {
    if (Bun.env.KONVOY_DEBUG === '1') throw error
    console.error(`konvoy: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// What shell completion asks konvoy for (src/commands/completion.ts): the words, one per line,
// and nothing on any failure - a completion script has nowhere to show an error.
function complete(what: string | undefined): number {
  try {
    if (what === 'sessions') for (const s of listSessions(openDb(dbPath()))) console.log(s.slug)
    else if (what === 'agents') for (const a of agentIds) console.log(a)
    else if (what === 'commands') for (const c of commandTable) console.log(c.name)
  } catch {
    // no store yet, or one that cannot be read
  }
  return 0
}

async function dispatch(command: string, rest: string[], cwd: string, slug: string | undefined, args: Args): Promise<number> {
  const name = resolveCommandName(command)
  if (!name) {
    console.error(unknownCommand(command, 'konvoy '))
    console.log(USAGE)
    return 2
  }
  const stray = unknownFlag(name, args.flags)
  if (stray) {
    console.error(stray)
    return 2
  }
  // `completion` prints a script and needs neither the store nor a config
  if (name === 'completion') return handlers.completion({ db: undefined as never, cfg: undefined as never, cwd, args, slug }, rest)

  const db = openDb(dbPath())
  // a session named from another directory carries its own project config, not the shell's:
  // model, effort, roles and the failover chain follow the repository the turn runs in
  const projectCwd = (slug ? getSessionBySlug(db, slug)?.cwd : undefined) ?? cwd
  const cfg = await loadConfig({ cwd: projectCwd })

  return handlers[name]({ db, cfg, cwd, args, slug }, rest)
}

// A person at a terminal gets the line editor; anything else - a pipe, a script, a terminal that
// cannot be put in raw mode - reads a line at a time, exactly as before.
function editorIo(level: ReturnType<typeof replColor>, history: History, completer: ReturnType<typeof replCompleter>): ReplIo | null {
  const stdin = process.stdin as unknown as Partial<RawInput> & { isTTY?: boolean }
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== 'function') return null
  const write = (text: string): void => {
    process.stdout.write(text)
  }
  const editor = terminalEditor({
    input: process.stdin as unknown as RawInput,
    write,
    columns: () => process.stdout.columns ?? 80,
    rows: () => process.stdout.rows ?? 24,
    history,
    completer,
    onResize: (redraw) => {
      process.stdout.on('resize', redraw)
      return () => process.stdout.off('resize', redraw)
    },
  })
  // a konvoy killed while the editor holds the terminal leaves it cooked, pasteless and with a cursor
  const forget = onExit(() => {
    editor.close()
    write(SHOW_CURSOR)
  })
  async function* none(): AsyncGenerator<string> {}
  return {
    lines: none(),
    write,
    tty: true,
    color: level,
    pause: () => undefined,
    resume: () => undefined,
    close: () => {
      editor.close()
      forget()
    },
    editor,
    columns: () => process.stdout.columns ?? 80,
  }
}

async function interactive(given: ReplIo | undefined, cwd: string, slug: string | undefined): Promise<number> {
  const db = openDb(dbPath())
  let cfg = await loadConfig({ cwd: (slug ? getSessionBySlug(db, slug)?.cwd : undefined) ?? cwd })
  // a terminal gets a banner naming the session, so creating one needs no announcement of its own
  const banner = given ? given.tty : Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const session = await startSession(db, cfg, cwd, slug, { quiet: banner })
  if (!session) {
    console.error(slug ? noSessionNamed(slug) : 'could not create a session here')
    return 2
  }
  const level = replColor()
  const history = given ? null : storeHistory(db, session.cwd)
  const io = given ?? (history ? editorIo(level, history, replCompleter(db, () => cfg)) : null) ?? terminalIo()
  // Only for a human at a terminal: a piped run is a script, and a banner in its output is noise.
  if (io.tty) {
    const lead = resolveAgent(cfg, session.lead)
    const facts = {
      version: VERSION,
      slug: session.slug,
      dir: tildify(sessionDir(session.cwd, session.slug)),
      agent: session.lead,
      harness: effectiveHarness(lead, 'user'),
      permission: lead.permission,
      model: lead.model,
      effort: lead.effort,
      goal: session.goal || undefined,
      roster: await Promise.all(
        agentIds
          .filter((a) => resolveAgent(cfg, a).enabled)
          .map(async (a) => ({ agent: a, ready: (await locate(a, { bin: resolveAgent(cfg, a).bin })).installed })),
      ),
      columns: process.stdout.columns ?? 80,
      last: (() => {
        const t = recentTurns(db, session.id, 1)[0]
        return t ? { agent: t.agent, ago: ago(t.startedAt, Date.now()), prompt: oneLine(t.prompt, 60) } : undefined
      })(),
    }
    for (const line of sessionBanner(facts, io.editor ? level : colorLevel(Bun.env, true))) io.write(`${line}\n`)
    io.write(io.editor ? '\n' : '')
  }
  try {
    return await runRepl(
      io,
      db,
      cfg,
      cwd,
      session,
      (tokens, current, extras) => {
        const a = parseArgs(tokens)
        const [cmd = '', ...r] = a._
        const name = resolveCommandName(cmd)
        if (!name) {
          console.error(unknownCommand(cmd, '/'))
          return 2
        }
        const stray = unknownFlag(name, a.flags)
        if (stray) {
          console.error(stray)
          return 2
        }
        return handlers[name]({ db, cfg: extras?.cfg ?? cfg, cwd, args: a, slug: current, signal: extras?.signal }, r)
      },
      {
        loadConfig: async (dir) => {
          cfg = await loadConfig({ cwd: dir })
          return cfg
        },
      },
    )
  } finally {
    io.pause()
    io.close?.()
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
