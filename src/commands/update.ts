import type { AgentId } from '../types'
import { agentIds } from '../adapters'
import { detect, type Detection } from '../core/detect'
import { resolveAgent } from '../config/load'
import type { Config } from '../config/schema'

const COMMANDS: Record<AgentId, string[]> = {
  claude: ['claude', 'update'],
  codex: ['codex', 'update'],
  kiro: ['kiro-cli', 'update'],
  opencode: ['opencode', 'upgrade'],
}

export function updateCommand(agent: AgentId, bin?: string): string[] {
  const [name, ...rest] = COMMANDS[agent]
  return [bin ?? name!, ...rest]
}

export interface UpdateDeps {
  detect: (agent: AgentId, opts: { bin?: string }) => Promise<Detection>
  spawn: (argv: string[]) => Promise<number>
}

const realUpdateDeps: UpdateDeps = {
  detect: (agent, opts) => detect(agent, opts),
  spawn: async (argv) => {
    const proc = Bun.spawn(argv, { stdio: ['inherit', 'inherit', 'inherit'] })
    return proc.exited
  },
}

export async function cmdUpdate(
  cfg: Config,
  opts: { all: boolean },
  deps: UpdateDeps = realUpdateDeps,
): Promise<number> {
  if (!opts.all) {
    console.log('konvoy is built from source: bun run build')
    console.log('to update the agent CLIs, run: konvoy update --all')
    return 0
  }

  let failures = 0
  for (const agent of agentIds) {
    const settings = resolveAgent(cfg, agent)
    if (!settings.enabled) {
      console.log(`- ${agent}: disabled in config, skipping`)
      continue
    }
    const before = await deps.detect(agent, { bin: settings.bin })
    if (!before.installed) {
      console.log(`- ${agent}: not installed, skipping`)
      continue
    }
    console.log(`updating ${agent} (${before.version})...`)
    const code = await deps.spawn(updateCommand(agent, settings.bin))
    if (code !== 0) {
      console.log(`! ${agent}: update exited with ${code}`)
      failures++
      continue
    }
    const after = await deps.detect(agent, { bin: settings.bin })
    console.log(`ok ${agent}: ${before.version} -> ${after.version}`)
  }
  return failures === 0 ? 0 : 1
}
