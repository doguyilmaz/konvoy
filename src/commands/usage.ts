import type { Database } from 'bun:sqlite'
import {
  turnsPerDay,
  turnsPerDayByAgent,
  usageAcrossSessions,
  usageByAgentModel,
  usageForSession,
  type UsageRow,
} from '../store/queries'
import { requireSession } from './messages'
import { formatUsage, outputColor } from '../format'
import { agentSparklines, heatmap, shareBars } from '../chart'
import { estimateAgentUsd, isPricingConfigured } from '../pricing'
import type { Config } from '../config/schema'
import type { Session } from '../types'

// the SPEND column mixes dollars and credits, so every table that shows it carries this line
const UNITS = "spend is in each agent's own unit; a dash means the CLI reported none"

export function cmdUsage(
  db: Database,
  cfg: Config,
  cwd: string,
  opts: { all: boolean; slug?: string; chart?: boolean; json?: boolean },
): number {
  let session: Session | null = null
  let rows: UsageRow[]

  if (opts.json) {
    if (!opts.all) {
      session = requireSession(db, cwd, opts.slug)
      if (!session) return 2
    }
    const id = session?.id
    const byModel = usageByAgentModel(db, id)
    const agents = (id ? usageForSession(db, id) : usageAcrossSessions(db)).map((r) => ({
      ...r,
      estimateUsd: estimateAgentUsd(r.agent, byModel, cfg.pricing),
    }))
    console.log(JSON.stringify({ session: session?.slug ?? null, agents, perDay: turnsPerDay(db, id) }, null, 2))
    return 0
  }

  if (opts.all) {
    rows = usageAcrossSessions(db)
    if (rows.length === 0) {
      console.log('no turns recorded yet')
      return 0
    }
    console.log('all sessions')
  } else {
    session = requireSession(db, cwd, opts.slug)
    if (!session) return 2
    rows = usageForSession(db, session.id)
    if (rows.length === 0) {
      console.log(`session ${session.slug} - no turns yet`)
      return 0
    }
    console.log(`session ${session.slug}`)
  }

  const sessionId = opts.all ? undefined : session?.id

  console.log(formatUsage(rows, cfg.pricing, usageByAgentModel(db, sessionId), outputColor()))
  console.log(
    isPricingConfigured(cfg.pricing)
      ? `${UNITS}; ~USD is estimated from rates configured as of ${cfg.pricing.asOf || 'an unspecified date'}`
      : UNITS,
  )

  if (opts.chart) {
    console.log('\nturns per day')
    console.log(heatmap(turnsPerDay(db, sessionId)))
    console.log('\nshare of turns')
    console.log(shareBars(rows.map((r) => ({ label: r.agent, value: r.turns }))))

    const perAgent = agentSparklines(turnsPerDayByAgent(db, sessionId))
    if (perAgent.length > 0) {
      console.log('\nturns per day by agent')
      const labelWidth = Math.max(...perAgent.map((r) => r.agent.length))
      for (const { agent, line } of perAgent) {
        console.log(`${agent.padEnd(labelWidth)}  ${line}`)
      }
    }
  }

  return 0
}
