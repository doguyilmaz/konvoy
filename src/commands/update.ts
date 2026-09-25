import type { AgentId } from '../types'
import { agentIds, getAdapter } from '../adapters'
import { detect, type Detection, clearDetectCache } from '../core/detect'
import { resolveAgent } from '../config/load'
import type { Config } from '../config/schema'
import { channelOf, kegOf, resolveLinks, updatePlan, type Origin, type Plan } from '../core/install'
import { requireAgent } from './messages'

export interface UpdateDeps {
  detect: (agent: AgentId, opts: { bin?: string }) => Promise<Detection>
  spawn: (argv: string[]) => Promise<number>
  /** which channel installed this binary; read from its path by default */
  origin?: (agent: AgentId, bin: string) => Origin
  /** how konvoy itself is updated, or how to do it by hand when konvoy cannot */
  self?: () => Plan | string
}

// the binary's path as PATH resolves it and the file its links end at, read into a channel
export function realOrigin(agent: AgentId, bin: string): Origin {
  const path = bin.includes('/') ? bin : Bun.which(bin)
  if (!path) return { channel: 'unknown' }
  const resolved = resolveLinks(path)
  return { channel: channelOf(agent, path, resolved), keg: kegOf(resolved) ?? kegOf(path) }
}

// konvoy follows its own install channel the same way it asks the agents to follow theirs
export function selfPlan(): Plan | string {
  if (Bun.isStandaloneExecutable) {
    const where = resolveLinks(process.execPath)
    if (where.includes('/Caskroom/') || where.includes('/Cellar/')) {
      return { command: 'brew upgrade --cask konvoy', argv: ['brew', 'upgrade', '--cask', 'konvoy'], why: 'installed with Homebrew' }
    }
    return `download the latest release over ${process.execPath}: https://github.com/doguyilmaz/konvoy/releases/latest`
  }
  const main = resolveLinks(Bun.main)
  if (main.includes('/node_modules/@doguyilmaz/konvoy/')) {
    return { command: 'bun add -g @doguyilmaz/konvoy@latest', argv: ['bun', 'add', '-g', '@doguyilmaz/konvoy@latest'], why: 'installed with bun' }
  }
  return 'git pull, then bun run build, in the checkout konvoy runs from'
}

const realUpdateDeps: UpdateDeps = {
  detect: (agent, opts) => detect(agent, opts),
  spawn: async (argv) => {
    const proc = Bun.spawn(argv, { stdio: ['inherit', 'inherit', 'inherit'] })
    return proc.exited
  },
  origin: realOrigin,
  self: selfPlan,
}

export async function cmdUpdate(
  cfg: Config,
  opts: { all: boolean; agents?: string[]; dryRun?: boolean },
  deps: UpdateDeps = realUpdateDeps,
): Promise<number> {
  const named = opts.agents ?? []
  if (!opts.all && named.length === 0) {
    const self = (deps.self ?? selfPlan)()
    console.log(`to update konvoy: ${typeof self === 'string' ? self : self.command}`)
    console.log('to update the agent CLIs: konvoy update --all, or konvoy update <agent>')
    return 0
  }

  const targets: AgentId[] = []
  for (const name of named) {
    const agent = requireAgent(name)
    if (!agent) return 2
    targets.push(agent)
  }
  const origin = deps.origin ?? realOrigin

  let failures = 0
  for (const agent of opts.all ? agentIds : targets) {
    const settings = resolveAgent(cfg, agent)
    if (!settings.enabled) {
      console.log(`- ${agent}: disabled in config, skipping`)
      continue
    }
    const before = await deps.detect(agent, { bin: settings.bin })
    if (!before.installed) {
      console.log(`- ${agent}: not installed, skipping - konvoy install ${agent}`)
      continue
    }
    const bin = settings.bin ?? getAdapter(agent).bin
    const plan = updatePlan(agent, origin(agent, bin), bin)
    if ('reason' in plan) {
      console.log(`- ${agent}: ${plan.reason}, skipping`)
      continue
    }
    console.log(`updating ${agent} (${before.version}), ${plan.why}: ${plan.command}`)
    if (opts.dryRun) continue
    const code = await deps.spawn(plan.argv)
    if (code !== 0) {
      console.log(`! ${agent}: update exited with ${code}`)
      failures++
      continue
    }
    // the memo would hand back the pre-update detection; the version line must come from a fresh --version
    clearDetectCache()
    const after = await deps.detect(agent, { bin: settings.bin })
    console.log(`ok ${agent}: ${before.version} -> ${after.version}`)
  }

  // konvoy last: an update that replaces the running binary should not stop the agents' updates
  if (opts.all) {
    const self = (deps.self ?? selfPlan)()
    if (typeof self === 'string') {
      console.log(`- konvoy: ${self}`)
    } else {
      console.log(`updating konvoy, ${self.why}: ${self.command}`)
      if (!opts.dryRun) {
        const code = await deps.spawn(self.argv)
        if (code !== 0) {
          console.log(`! konvoy: update exited with ${code}`)
          failures++
        }
      }
    }
  }
  return failures === 0 ? 0 : 1
}
