import { parseArgs } from './args'
import { loadConfig, resolveAgent } from './config/load'
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
import type { AgentId } from './types'
import pkg from '../package.json'

const VERSION = pkg.version

const USAGE = `konvoy ${VERSION}

  konvoy new "<goal>"           create a session in this directory
  konvoy send <agent> "<msg>"   run one turn against one agent
  konvoy ls                     list sessions
  konvoy resume [session]       make a session current and show its roster
  konvoy config get|set         read or write layered configuration
  konvoy rm <session> --yes     delete a konvoy session (foreign sessions survive)
  konvoy roster                 who is in the convoy
  konvoy usage [--all]          what this session spent, per agent
  konvoy status                 versions, auth and roster
  konvoy attach <agent>         open that agent's own interface, same session
  konvoy doctor                 check installs, logins, effort and model overlap
  konvoy update [--all]         update konvoy, and with --all the agent CLIs
  konvoy version                konvoy and agent versions

agents: claude, codex, kiro, opencode
flags:  --session <slug>
`

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

  const cfg = await loadConfig({ cwd })
  const db = openDb(dbPath())

  switch (command) {
    case 'new':
    case 'start':
      return cmdNew(db, cfg, cwd, rest.join(' '))
    case 'send': {
      const [agent, ...prompt] = rest
      if (!agent || prompt.length === 0) {
        console.error('usage: konvoy send <agent> "<message>"')
        console.error('a message beginning with a dash goes after --, as in: konvoy send codex -- "-1 first"')
        return 2
      }
      return cmdSend(db, cfg, cwd, agent, prompt.join(' '), slug)
    }
    case 'ls':
    case 'sessions':
      return cmdLs(db)
    case 'roster':
      return cmdRoster(db, cfg, cwd, slug)
    case 'status':
      return cmdStatus(db, cfg, cwd, slug)
    case 'attach': {
      const [agent] = rest
      if (!agent) {
        console.error('usage: konvoy attach <agent>')
        return 2
      }
      return cmdAttach(db, cwd, agent, slug, resolveAgent(cfg, agent as AgentId).bin)
    }
    case 'doctor':
      return cmdDoctor(cfg)
    case 'update':
      return cmdUpdate(cfg, { all: args.flags.all === true })
    case 'resume':
      return cmdResume(db, cfg, cwd, rest[0] ?? slug)
    case 'config': {
      const [action, key, value] = rest
      return cmdConfig(cfg, cwd, action ?? 'get', key, value, { global: args.flags.global === true })
    }
    case 'rm': {
      const [target] = rest
      if (!target) {
        console.error('usage: konvoy rm <session> --yes')
        return 2
      }
      return cmdRm(db, cwd, target, { yes: args.flags.yes === true })
    }
    case 'usage':
      return cmdUsage(db, cwd, { all: args.flags.all === true, slug })
    case 'version':
      console.log(`konvoy ${VERSION}`)
      return cmdStatus(db, cfg, cwd, slug)
    default:
      console.error(`unknown command "${command}"`)
      console.log(USAGE)
      return 2
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
