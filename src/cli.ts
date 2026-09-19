import { parseArgs } from './args'
import { loadConfig } from './config/load'
import { openDb } from './store/db'
import { dbPath } from './paths'
import { cmdNew } from './commands/new'
import { cmdSend } from './commands/send'
import { cmdLs } from './commands/ls'
import { cmdRoster } from './commands/roster'
import { cmdStatus } from './commands/status'

const VERSION = '0.1.0'

const USAGE = `konvoy ${VERSION}

  konvoy new "<goal>"           create a session in this directory
  konvoy send <agent> "<msg>"   run one turn against one agent
  konvoy ls                     list sessions
  konvoy roster                 who is in the convoy
  konvoy status                 versions, auth and roster
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
