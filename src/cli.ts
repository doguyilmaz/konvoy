import type { Database } from 'bun:sqlite'
import { parseArgs, type Args } from './args'
import { loadConfig, resolveAgent } from './config/load'
import { getSessionBySlug } from './store/queries'
import { agentIds } from './config/schema'
import type { Config } from './config/schema'
import { openDb } from './store/db'
import { dbPath } from './paths'
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
import { cmdUsage } from './commands/usage'
import { cmdDashboard } from './commands/dashboard'
import { formatCommandList, resolveCommandName, type CommandName } from './commands/table'
import type { AgentId } from './types'
import pkg from '../package.json'

const VERSION = pkg.version

export const USAGE = `konvoy ${VERSION}

${formatCommandList()}

agents: ${agentIds.join(', ')}
flags:  --session <slug>
`

interface CommandContext {
  db: Database
  cfg: Config
  cwd: string
  args: Args
  slug: string | undefined
}

type Handler = (ctx: CommandContext, rest: string[]) => number | Promise<number>

// Every key of CommandName must be handled here — TypeScript's excess/missing property
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
      console.error('usage: konvoy attach <agent>')
      return 2
    }
    return cmdAttach(ctx.db, ctx.cwd, agent, ctx.slug, resolveAgent(ctx.cfg, agent as AgentId).bin)
  },
  doctor: (ctx) => cmdDoctor(ctx.cfg),
  update: (ctx) => cmdUpdate(ctx.cfg, { all: ctx.args.flags.all === true }),
  resume: (ctx, rest) => cmdResume(ctx.db, ctx.cfg, ctx.cwd, rest[0] ?? ctx.slug),
  config: (ctx, rest) => {
    const [action, key, value] = rest
    return cmdConfig(ctx.cfg, ctx.cwd, action ?? 'get', key, value, { global: ctx.args.flags.global === true })
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
    return cmdStatus(ctx.db, ctx.cfg, ctx.cwd, ctx.slug)
  },
  dashboard: ({ db, cfg, cwd, args, slug }) =>
    cmdDashboard(db, cfg, cwd, {
      port: typeof args.flags.port === 'string' ? Number(args.flags.port) : undefined,
      slug,
    }),
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const [command, ...rest] = args._
  const cwd = process.cwd()
  const slug = typeof args.flags.session === 'string' ? args.flags.session : undefined

  if (!command || command === 'help' || args.flags.help) {
    console.log(USAGE)
    // asking for help is not a usage error; running konvoy with nothing is
    return command || args.flags.help ? 0 : 1
  }

  try {
    return await dispatch(command, rest, cwd, slug, args)
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
    console.error(`unknown command "${command}"`)
    console.log(USAGE)
    return 2
  }

  return handlers[name]({ db, cfg, cwd, args, slug }, rest)
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
