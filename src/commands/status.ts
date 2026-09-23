import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { agentIds } from '../adapters'
import { resolveAgent } from '../config/load'
import { detect, detectAuth } from '../core/detect'
import { formatVersions, outputColor, type AgentStatusRow } from '../format'
import { cmdRoster } from './roster'

export async function cmdStatus(
  db: Database,
  cfg: Config,
  cwd: string,
  slug?: string,
  opts: { roster?: boolean } = {},
): Promise<number> {
  const rows: AgentStatusRow[] = await Promise.all(
    agentIds.map(async (agent) => {
      const settings = resolveAgent(cfg, agent)
      const found = await detect(agent, { model: settings.model, bin: settings.bin })
      const auth = found.installed
        ? await detectAuth(agent, { bin: settings.bin })
        : { agent, authed: null, detail: 'not installed' }
      return { agent, installed: found.installed, version: found.version, authed: auth.authed, detail: auth.detail }
    }),
  )
  console.log(formatVersions(rows, outputColor()))
  for (const r of rows) {
    if (!r.installed) console.log(`warning: ${r.agent} is not installed - it will be skipped`)
    else if (r.authed === false) console.log(`warning: ${r.agent}: ${r.detail}`)
  }
  // status reports; it does not judge. A directory with no session is not a failure of the
  // command, and cmdRoster has already said so on stderr.
  if (opts.roster !== false) cmdRoster(db, cfg, cwd, slug)
  return 0
}
