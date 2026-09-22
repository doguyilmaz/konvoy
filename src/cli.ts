#!/usr/bin/env bun
import type { Database } from 'bun:sqlite'
import { parseArgs, type Args } from './args'
import { loadConfig, resolveAgent } from './config/load'
import { getSessionBySlug } from './store/queries'
import { agentIds } from './config/schema'
import type { Config } from './config/schema'
import { openDb } from './store/db'
import { dbPath, sessionDir } from './paths'
import { sessionBanner } from './render'
import { colorEnabled } from './style'
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
import { commandTable, formatRows, resolveCommandName, type CommandName } from './commands/table'
import { noSessionNamed, unknownCommand } from './commands/messages'
import { runRepl, startSession, terminalIo, type ReplIo } from './commands/repl'
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
}

type Handler = (ctx: CommandContext, rest: string[]) => number | Promise<number>

// Every key of CommandName must be handled here - TypeScript's excess/missing property
// checks on an object literal assigned to Record<CommandName, Handler> make an
// undocumented-yet-dispatched or dispatched-yet-undocumented command a compile error.
const handlers: Record<CommandName, Handler> = {
  new: (ctx, rest) => cmdNew(ctx.db, ctx.cfg, ctx.cwd, rest.join(' ')),
  send: (ctx, rest) => {
    const [agent, ...prompt] = rest
    if (!agent || prompt.length === 0) {
      console.error('usage: konvoy send <agent> "<message>"')
      console.error('a message beginning with a dash goes after --, as in: konvoy send codex -- "-1 first"')
      return 2
    }
    return cmdSend(ctx.db, ctx.cfg, ctx.cwd, agent, prompt.join(' '), ctx.slug)
  },
  ls: (ctx) => cmdLs(ctx.db),
  roster: (ctx) => cmdRoster(ctx.db, ctx.cfg, ctx.cwd, ctx.slug),
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
    }),
  version: (ctx) => {
    console.log(`konvoy ${VERSION}`)
    return cmdStatus(ctx.db, ctx.cfg, ctx.cwd, ctx.slug, { roster: false })
  },
  dashboard: ({ db, cfg, cwd, args, slug }) =>
    cmdDashboard(db, cfg, cwd, {
      port: typeof args.flags.port === 'string' ? Number(args.flags.port) : undefined,
      slug,
    }),
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

  try {
    return command ? await dispatch(command, rest, cwd, slug, args) : await interactive(io, cwd, slug)
  } catch (error) {
    if (Bun.env.KONVOY_DEBUG === '1') throw error
    console.error(`konvoy: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function dispatch(command: string, rest: string[], cwd: string, slug: string | undefined, args: Args): Promise<number> {
  const db = openDb(dbPath())
  // a session named from another directory carries its own project config, not the shell's:
  // model, effort, roles and the failover chain follow the repository the turn runs in
  const projectCwd = (slug ? getSessionBySlug(db, slug)?.cwd : undefined) ?? cwd
  const cfg = await loadConfig({ cwd: projectCwd })

  const name = resolveCommandName(command)
  if (!name) {
    console.error(unknownCommand(command, 'konvoy '))
    console.log(USAGE)
    return 2
  }

  return handlers[name]({ db, cfg, cwd, args, slug }, rest)
}

async function interactive(given: ReplIo | undefined, cwd: string, slug: string | undefined): Promise<number> {
  const db = openDb(dbPath())
  const cfg = await loadConfig({ cwd: (slug ? getSessionBySlug(db, slug)?.cwd : undefined) ?? cwd })
  const session = await startSession(db, cfg, cwd, slug)
  if (!session) {
    console.error(slug ? noSessionNamed(slug) : 'could not create a session here')
    return 2
  }
  const io = given ?? terminalIo()
  // Only for a human at a terminal: a piped run is a script, and a banner in its output is noise.
  if (io.tty) {
    const lead = resolveAgent(cfg, session.lead)
    const facts = {
      version: VERSION,
      slug: session.slug,
      dir: sessionDir(session.cwd, session.slug),
      agent: session.lead,
      harness: lead.harness,
      permission: lead.permission,
    }
    for (const line of sessionBanner(facts, colorEnabled(Bun.env, true))) io.write(`${line}\n`)
  }
  try {
    return await runRepl(io, db, cfg, cwd, session, (tokens, current) => {
      const a = parseArgs(tokens)
      const [cmd = '', ...r] = a._
      const name = resolveCommandName(cmd)
      if (!name) {
        console.error(unknownCommand(cmd, '/'))
        return 2
      }
      return handlers[name]({ db, cfg, cwd, args: a, slug: current }, r)
    })
  } finally {
    io.pause()
    io.close?.()
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
