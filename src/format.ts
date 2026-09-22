import type { AgentId } from './types'
import type { UsageRow } from './store/queries'
import { estimateAgentUsd, isPricingConfigured, type ModelUsage, type Pricing } from './pricing'

export interface RosterRow {
  agent: AgentId
  status: string
  model: string
  effort: string
  foreignId: string | null
  turns: number
  costUsd: number
  credits: number
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n') + '\n'
}

export function formatRoster(rows: RosterRow[]): string {
  return table(
    ['AGENT', 'STATUS', 'MODEL', 'EFFORT', 'SESSION', 'TURNS', 'COST'],
    rows.map((r) => [r.agent, r.status, r.model || '-', r.effort, r.foreignId ?? '-', String(r.turns), cost(r)]),
  )
}

function cost(r: RosterRow): string {
  if (r.costUsd > 0) return `$${r.costUsd.toFixed(2)}`
  if (r.credits > 0) return `${r.credits.toFixed(3)} cr`
  return '-'
}

// exported so the dashboard renders the same string the terminal does, rather than
// reimplementing the credits-before-dollars rule and risking the two drifting apart
export function spend(row: UsageRow): string {
  // credits win when both are non-zero: they're what the agent actually charged, and the
  // cost estimator derives its dollar figure from credits the same way - the two must
  // never disagree about which number is the real one for a given row.
  if (row.credits > 0) return `${row.credits.toFixed(3)} cr`
  if (row.costUsd > 0) return `$${row.costUsd.toFixed(2)}`
  return '-'
}

function usdCell(row: UsageRow, modelRows: ModelUsage[], pricing: Pricing): string {
  const est = estimateAgentUsd(row.agent, modelRows, pricing)
  if (est === null) return '-'
  // an already-real dollar figure keeps money's usual 2 decimals; a credit- or token-derived
  // estimate gets the extra precision those small figures are shown with, or it rounds to nothing
  return row.costUsd > 0 ? `$${est.toFixed(2)}` : `$${est.toFixed(3)}`
}

export function formatUsage(rows: UsageRow[], pricing?: Pricing, modelRows: ModelUsage[] = []): string {
  const showUsd = pricing !== undefined && isPricingConfigured(pricing)
  const header = ['AGENT', 'TURNS', 'IN', 'OUT', 'SPEND', ...(showUsd ? ['~USD'] : []), 'GATE']
  return table(
    header,
    rows.map((r) => [
      r.agent,
      String(r.turns),
      String(r.inputTokens),
      String(r.outputTokens),
      spend(r),
      ...(showUsd ? [usdCell(r, modelRows, pricing!)] : []),
      r.gateKnown > 0 ? `${r.gatePassed}/${r.gateKnown}` : '-',
    ]),
  )
}

export function duplicateModels(rows: RosterRow[]): string[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.model) continue
    counts.set(r.model, (counts.get(r.model) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([model]) => model)
}

export interface AgentStatusRow {
  agent: AgentId
  installed: boolean
  version: string | null
  authed: boolean | null
  detail?: string
}

export function formatVersions(rows: AgentStatusRow[]): string {
  return table(
    ['AGENT', 'VERSION', 'AUTH', 'DETAIL'],
    rows.map((r) => [
      r.agent,
      r.installed ? (r.version ?? 'unknown') : 'not installed',
      r.authed === null ? 'unknown' : r.authed ? 'ok' : 'login required',
      r.detail ?? '',
    ]),
  )
}
