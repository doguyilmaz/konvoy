import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { agentIds } from '../adapters'
import { resolveAgent } from '../config/load'
import { currentSession, getSessionBySlug, listBindings } from '../store/queries'
import { duplicateModels, formatRoster, type RosterRow } from '../format'

export function cmdRoster(db: Database, cfg: Config, cwd: string, slug?: string): number {
  const session = slug ? getSessionBySlug(db, slug) : currentSession(db, cwd)
  if (!session) {
    console.error('no konvoy session here — run `konvoy new "<goal>"` first')
    return 2
  }

  const bindings = new Map(listBindings(db, session.id).map((b) => [b.agent, b]))
  const rows: RosterRow[] = agentIds.map((agent) => {
    const settings = resolveAgent(cfg, agent)
    const binding = bindings.get(agent) ?? null
    return {
      agent,
      status: !settings.enabled ? 'disabled' : (binding?.status ?? 'unbound'),
      model: settings.model ?? '',
      effort: settings.effort,
      foreignId: binding?.foreignId ?? null,
      turns: binding?.turns ?? 0,
      costUsd: binding?.costUsd ?? 0,
      credits: binding?.credits ?? 0,
    }
  })

  console.log(`session ${session.slug} — ${session.goal}`)
  console.log(formatRoster(rows))
  for (const model of duplicateModels(rows)) {
    console.log(`warning: ${model} is used by more than one agent — a second opinion from the same model is not one`)
  }
  return 0
}
