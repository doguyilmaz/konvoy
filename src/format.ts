import type { AgentId } from './types'

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
