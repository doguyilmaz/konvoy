import type { AgentId } from '../types'
import type { Config } from '../config/schema'
import { agentIds } from '../adapters'
import { resolveAgent } from '../config/load'
import { clearDetectCache, detect, type Detection } from '../core/detect'
import { installPlan, PACKAGING, type Recipe } from '../core/install'
import { outputColor, table } from '../format'
import { home, join } from '../paths'
import { requireAgent } from './messages'

export interface InstallDeps {
  detect: (agent: AgentId, opts: { bin?: string }) => Promise<Detection>
  spawn: (argv: string[]) => Promise<number>
  has: (tool: string) => boolean
  /** a yes or no from the person at the terminal; null when there is nobody to ask */
  confirm: (question: string) => boolean | null
  exists: (path: string) => Promise<boolean>
}

const realInstallDeps: InstallDeps = {
  detect: (agent, opts) => detect(agent, opts),
  spawn: async (argv) => Bun.spawn([...argv], { stdio: ['inherit', 'inherit', 'inherit'] }).exited,
  has: (tool) => Bun.which(tool) !== null,
  confirm: (question) => {
    if (!process.stdin.isTTY) return null
    const answer = prompt(`${question} [y/N]`)
    return answer !== null && /^y(es)?$/i.test(answer.trim())
  },
  exists: (path) => Bun.file(path).exists(),
}

const VIAS = ['script', 'npm', 'brew', 'bun'] as const

export interface InstallOptions {
  agents: string[]
  all: boolean
  via?: string
  yes: boolean
  dryRun: boolean
}

// Installing an agent runs its vendor's installer - for most of them a script fetched over the
// network and piped to a shell. That is the vendor's documented way, and konvoy adds nothing to it,
// but it is still code from somewhere else: the exact command is shown first, and it runs only on a
// yes, or on --yes from someone who has already read it.
export async function cmdInstall(cfg: Config, opts: InstallOptions, deps: InstallDeps = realInstallDeps): Promise<number> {
  if (opts.via !== undefined && !(VIAS as readonly string[]).includes(opts.via)) {
    console.error(`--via is one of ${VIAS.join(', ')}`)
    return 2
  }
  const via = opts.via as Recipe['via'] | undefined

  if (!opts.all && opts.agents.length === 0) return overview(cfg, deps)

  const targets: AgentId[] = []
  for (const name of opts.agents) {
    const agent = requireAgent(name)
    if (!agent) return 2
    targets.push(agent)
  }

  let failures = 0
  for (const agent of opts.all ? agentIds : targets) {
    const settings = resolveAgent(cfg, agent)
    if (opts.all && !settings.enabled) {
      console.log(`- ${agent}: disabled in config, skipping`)
      continue
    }
    const found = await deps.detect(agent, { bin: settings.bin })
    if (found.installed) {
      console.log(`- ${agent}: already installed (${found.version ?? 'unknown version'}) - konvoy update ${agent} to update it`)
      continue
    }
    const choice = installPlan(agent, { via, has: deps.has })
    if ('reason' in choice) {
      console.log(`! ${choice.reason}`)
      failures++
      continue
    }
    const { plan } = choice
    console.log(`installing ${agent}, ${plan.why}: ${plan.command}`)
    console.log(`  source: ${PACKAGING[agent].docs}`)
    if (opts.dryRun) continue
    if (!opts.yes) {
      const answer = deps.confirm('  run it?')
      if (answer === null) {
        console.log(`! ${agent}: nothing run - there is no terminal to confirm at; pass --yes to run it anyway`)
        failures++
        continue
      }
      if (!answer) {
        console.log(`- ${agent}: skipped`)
        continue
      }
    }
    const code = await deps.spawn(plan.argv)
    if (code !== 0) {
      console.log(`! ${agent}: the installer exited with ${code}`)
      failures++
      continue
    }
    clearDetectCache()
    const after = await deps.detect(agent, { bin: settings.bin })
    if (after.installed) {
      console.log(`ok ${agent}: ${after.version ?? 'installed'}`)
      continue
    }
    // An installer that puts its binary somewhere this shell's PATH does not reach succeeded, and
    // every konvoy command would still say it is missing. Say where it went.
    const landed = await firstExisting(PACKAGING[agent].binPaths ?? [], deps)
    if (landed) {
      console.log(`! ${agent}: installed to ${landed}, which is not on PATH - add its directory to PATH, or run`)
      console.log(`    konvoy config set agents.${agent}.bin ${landed} --global`)
    } else {
      console.log(`! ${agent}: the installer finished but ${agent} is still not found - open a new shell and run konvoy doctor`)
    }
    failures++
  }
  return failures === 0 ? 0 : 1
}

async function firstExisting(paths: readonly string[], deps: InstallDeps): Promise<string | null> {
  for (const p of paths) {
    const full = p.startsWith('~/') ? join(home(), p.slice(2)) : p
    if (await deps.exists(full)) return full
  }
  return null
}

// `konvoy install` with nothing named: every agent, whether it is here, and what would install it
async function overview(cfg: Config, deps: InstallDeps): Promise<number> {
  const rows = await Promise.all(
    agentIds.map(async (agent) => {
      const settings = resolveAgent(cfg, agent)
      const found = await deps.detect(agent, { bin: settings.bin })
      const choice = installPlan(agent, { has: deps.has })
      const how = found.installed ? '' : 'reason' in choice ? choice.reason : choice.plan.command
      const status = !settings.enabled ? 'disabled' : found.installed ? (found.version ?? 'ok') : 'not installed'
      return [agent, status, how]
    }),
  )
  console.log(table(['AGENT', 'STATUS', 'INSTALL WITH'], rows, { color: outputColor() }).trimEnd())
  console.log('\nkonvoy install <agent> runs the one shown; konvoy install --all installs every missing one')
  return 0
}
