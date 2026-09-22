import type { Database } from 'bun:sqlite'
import {
  turnsPerDay,
  turnsPerDayByAgent,
  usageAcrossSessions,
  usageByAgentModel,
  usageForSession,
} from '../store/queries'
import type { Config } from '../config/schema'
import { estimateAgentUsd } from '../pricing'
import { spend } from '../format'

export interface DashboardData {
  title: string
  asOf: string
  agents: {
    agent: string
    turns: number
    inputTokens: number
    outputTokens: number
    spend: string
    estimateUsd: number | null
  }[]
  days: { day: string; count: number }[]
  byAgentDay: { agent: string; day: string; count: number }[]
  totals: { turns: number; inputTokens: number; outputTokens: number }
}

// collect is a pure read of the same tables `konvoy usage --chart` reads, through the same
// queries - a parallel query here is exactly how the two views would start disagreeing
export function collect(db: Database, cfg: Config, sessionId?: string): DashboardData {
  const rows = sessionId ? usageForSession(db, sessionId) : usageAcrossSessions(db)
  const modelRows = usageByAgentModel(db, sessionId)

  const agents = rows.map((r) => ({
    agent: r.agent,
    turns: r.turns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    spend: spend(r),
    estimateUsd: estimateAgentUsd(r.agent, modelRows, cfg.pricing),
  }))

  const totals = rows.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    { turns: 0, inputTokens: 0, outputTokens: 0 },
  )

  return {
    title: '',
    asOf: cfg.pricing.asOf,
    agents,
    days: turnsPerDay(db, sessionId),
    byAgentDay: turnsPerDayByAgent(db, sessionId),
    totals,
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// every day between the first and last, inclusive - gaps filled with zero downstream - so
// bars line up between agents the same way the terminal's sparklines line up columns
function expandDays(start: string, end: string): string[] {
  const days: string[] = []
  for (
    const cursor = new Date(`${start}T00:00:00Z`);
    cursor <= new Date(`${end}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    days.push(cursor.toISOString().slice(0, 10))
  }
  return days
}

function usdCell(a: DashboardData['agents'][number]): string {
  if (a.estimateUsd === null) return '-'
  return a.spend.startsWith('$') ? `$${a.estimateUsd.toFixed(2)}` : `$${a.estimateUsd.toFixed(3)}`
}

function totalsBarsSvg(days: { day: string; count: number }[]): string {
  if (days.length === 0) return '<p class="empty">no turns recorded yet</p>'
  const range = expandDays(days[0]!.day, days[days.length - 1]!.day)
  const counts = new Map(days.map((d) => [d.day, d.count]))
  const values = range.map((d) => counts.get(d) ?? 0)
  const max = Math.max(...values, 1)

  const barW = 14
  const gap = 4
  const height = 84
  const floor = height - 14
  const width = range.length * (barW + gap)

  const bars = values
    .map((v, i) => {
      const h = v > 0 ? Math.max(1, Math.round((v / max) * (floor - 4))) : 0
      const x = i * (barW + gap)
      const y = floor - h
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2"></rect><text x="${x + barW / 2}" y="${height - 2}" text-anchor="middle">${escape(range[i]!.slice(5))}</text>`
    })
    .join('')

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="turns per day">${bars}</svg>`
}

function agentBarsSvg(rows: { agent: string; day: string; count: number }[]): string {
  if (rows.length === 0) return '<p class="empty">no turns recorded yet</p>'

  const sortedDays = [...new Set(rows.map((r) => r.day))].sort()
  const range = expandDays(sortedDays[0]!, sortedDays[sortedDays.length - 1]!)

  const byAgent = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, new Map())
    byAgent.get(r.agent)!.set(r.day, r.count)
  }

  const series = [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, dayCounts]) => ({ agent, values: range.map((d) => dayCounts.get(d) ?? 0) }))

  // one shared max across every agent - a per-row scale would draw a quiet agent's two
  // turns at a busy agent's height, hiding exactly the comparison this chart is for
  const sharedMax = Math.max(...series.flatMap((s) => s.values), 1)

  const barW = 10
  const gap = 3
  const rowHeight = 34
  const width = range.length * (barW + gap)

  const rowsHtml = series
    .map(({ agent, values }) => {
      const bars = values
        .map((v, i) => {
          const h = v > 0 ? Math.max(1, Math.round((v / sharedMax) * (rowHeight - 2))) : 0
          const x = i * (barW + gap)
          const y = rowHeight - h
          return `<rect x="${x}" y="${y}" width="${barW}" height="${h}"></rect>`
        })
        .join('')
      return `<div class="agent-row" data-agent="${escape(agent)}"><span class="agent-label">${escape(agent)}</span><svg viewBox="0 0 ${width} ${rowHeight}" width="${width}" height="${rowHeight}" role="img" aria-label="turns per day for ${escape(agent)}">${bars}</svg></div>`
    })
    .join('')

  return `<div class="agent-bars">${rowsHtml}</div>`
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; max-width: 860px; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  .totals { color: #666; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.35rem 0.75rem 0.35rem 0; border-bottom: 1px solid #8883; }
  h2 { font-size: 1rem; margin-top: 2rem; }
  svg rect { fill: currentColor; opacity: 0.75; }
  svg text { font-size: 8px; fill: currentColor; opacity: 0.6; }
  .agent-row { display: flex; align-items: center; gap: 0.75rem; margin: 0.4rem 0; }
  .agent-label { width: 5rem; flex: none; }
  .empty, .note { color: #888; }
`

export function renderPage(data: DashboardData): string {
  const title = escape(data.title)

  const agentRows = data.agents
    .map(
      (a) => `<tr>
        <td>${escape(a.agent)}</td>
        <td>${a.turns}</td>
        <td>${a.inputTokens}</td>
        <td>${a.outputTokens}</td>
        <td>${escape(a.spend)}</td>
        <td>${usdCell(a)}</td>
      </tr>`,
    )
    .join('')

  const anyPriced = data.agents.some((a) => a.estimateUsd !== null)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>konvoy dashboard - ${title}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${title}</h1>
<p class="totals">${data.totals.turns} turns · ${data.totals.inputTokens} in · ${data.totals.outputTokens} out</p>

<table>
<thead><tr><th>AGENT</th><th>TURNS</th><th>IN</th><th>OUT</th><th>SPEND</th><th>~USD</th></tr></thead>
<tbody>${agentRows}</tbody>
</table>
${anyPriced ? `<p class="note">~USD is estimated from rates configured as of ${escape(data.asOf || 'an unspecified date')}</p>` : ''}

<h2>turns per day</h2>
${totalsBarsSvg(data.days)}

<h2>turns per day by agent</h2>
${agentBarsSvg(data.byAgentDay)}
</body>
</html>`
}
