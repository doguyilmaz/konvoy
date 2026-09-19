import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { agentIds } from '../adapters'
import { resolveAgent } from '../config/load'
import { detect, detectAuth } from '../core/detect'
import { formatVersions, type AgentStatusRow } from '../format'
import { cmdRoster } from './roster'

export async function cmdStatus(db: Database, cfg: Config, cwd: string, slug?: string): Promise<number> {
  const rows: AgentStatusRow[] = await Promise.all(
    agentIds.map(async (agent) => {
      const settings = resolveAgent(cfg, agent)
      const found = await detect(agent, settings.model)
      const auth = found.installed
        ? await detectAuth(agent, settings.bin)
        : { agent, authed: null, detail: 'not installed' }
      return { agent, installed: found.installed, version: found.version, authed: auth.authed, detail: auth.detail }
    }),
  )
  console.log(formatVersions(rows))
  for (const r of rows) {
    if (!r.installed) console.log(`warning: ${r.agent} is not installed — it will be skipped`)
    else if (r.authed === false) console.log(`warning: ${r.agent}: ${r.detail}`)
  }
  const code = cmdRoster(db, cfg, cwd, slug)
  return code === 2 ? 0 : code
}
