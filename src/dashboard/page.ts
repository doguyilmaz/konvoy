import type { Database } from 'bun:sqlite'
import {
  latestTurns,
  recentTurns,
  turnsPerDay,
  turnsPerDayByAgent,
  usageAcrossSessions,
  usageByAgentModel,
  usageForSession,
  type TurnRecord,
} from '../store/queries'
import type { Config } from '../config/schema'
import { estimateAgentUsd } from '../pricing'
import { ago, spend } from '../format'
import { duration } from '../render'
import { outcome } from '../commands/log'

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
  totals: { turns: number; inputTokens: number; outputTokens: number; costUsd?: number; credits?: number; gatePassed?: number; gateKnown?: number }
  /** the latest turns, newest first */
  recent?: { agent: string; prompt: string; outcome: string; ago: string; took: string }[]
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
      costUsd: acc.costUsd + r.costUsd,
      credits: acc.credits + r.credits,
      gatePassed: acc.gatePassed + r.gatePassed,
      gateKnown: acc.gateKnown + r.gateKnown,
    }),
    { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0, gatePassed: 0, gateKnown: 0 },
  )

  const now = Date.now()
  const latest: TurnRecord[] = sessionId ? recentTurns(db, sessionId, 12) : latestTurns(db, 12)

  return {
    title: '',
    asOf: cfg.pricing.asOf,
    agents,
    days: turnsPerDay(db, sessionId),
    byAgentDay: turnsPerDayByAgent(db, sessionId),
    totals,
    recent: latest.map((t) => ({
      agent: t.agent,
      prompt: t.prompt,
      outcome: outcome(t),
      ago: ago(t.startedAt, now),
      took: t.exitCode === -1 ? '-' : duration(Math.max(0, t.endedAt - t.startedAt)),
    })),
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

const compact = (n: number): string => (n < 1000 ? String(n) : n < 999_950 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1_000_000).toFixed(1)}M`)
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

// A column with a 4px rounded data end and a square base on the baseline.
function column(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function totalsBarsSvg(days: { day: string; count: number }[]): string {
  if (days.length === 0) return '<p class="empty">no turns recorded yet</p>'
  const range = expandDays(days[0]!.day, days[days.length - 1]!.day)
  const counts = new Map(days.map((d) => [d.day, d.count]))
  const values = range.map((d) => counts.get(d) ?? 0)
  const max = Math.max(...values, 1)

  // the chart spans the page: a slot per day, the bar inside it never thicker than 24px
  const slot = Math.max(8, Math.min(64, Math.floor(900 / range.length)))
  const barW = Math.min(24, Math.max(4, Math.round(slot * 0.62)))
  const height = 150
  const top = 16
  const floor = height - 22
  const width = Math.max(range.length * slot, 120)
  // a date under every column collides once the slots narrow; every nth keeps them apart
  const every = Math.max(1, Math.ceil(44 / slot))

  const marks = values
    .map((v, i) => {
      const h = v > 0 ? Math.max(2, Math.round((v / max) * (floor - top))) : 0
      const x = i * slot + (slot - barW) / 2
      const tip = escape(`${range[i]} · ${plural(v, 'turn')}`)
      const label = i % every === 0 ? `<text x="${x + barW / 2}" y="${height - 6}" text-anchor="middle">${escape(range[i]!.slice(5))}</text>` : ''
      const bar = h > 0 ? `<path class="bar" d="${column(x, floor - h, barW, h)}"></path>` : ''
      // the hit target is the whole slot, not the painted pixels
      return `<g class="hit" data-tip="${tip}" tabindex="0"><rect class="target" x="${i * slot}" y="${top}" width="${slot}" height="${floor - top}"></rect>${bar}</g>${label}`
    })
    .join('')

  const axis = `<line class="axis" x1="0" x2="${width}" y1="${floor}" y2="${floor}"></line><text class="tick" x="0" y="${top - 4}">${max} max</text>`
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="turns per day">${axis}${marks}</svg>`
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

  // the same width budget as the chart above, so a day sits at one place down the column
  const step = Math.max(5, Math.min(28, Math.floor(720 / range.length)))
  const gap = step > 8 ? 4 : 2
  const barW = Math.min(24, step - gap)
  const rowHeight = 34
  const width = range.length * (barW + gap)

  const rowsHtml = series
    .map(({ agent, values }) => {
      const total = values.reduce((a, b) => a + b, 0)
      const bars = values
        .map((v, i) => {
          const h = v > 0 ? Math.max(1, Math.round((v / sharedMax) * (rowHeight - 2))) : 0
          const x = i * (barW + gap)
          const y = rowHeight - h
          return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${h > 3 ? 2 : 0}" data-tip="${escape(`${agent} · ${range[i]} · ${plural(v, 'turn')}`)}"></rect>`
        })
        .join('')
      const color = /^[a-z]+$/.test(agent) ? ` style="--series: var(--agent-${agent}, var(--accent))"` : ''
      return `<div class="agent-row" data-agent="${escape(agent)}"${color}><span class="agent-label"><i class="swatch"></i>${escape(agent)}<small>${plural(total, 'turn')}</small></span><svg viewBox="0 0 ${Math.max(width, 1)} ${rowHeight}" width="${width}" height="${rowHeight}" role="img" aria-label="turns per day for ${escape(agent)}">${bars}</svg></div>`
    })
    .join('')

  return `<div class="agent-bars">${rowsHtml}</div>`
}

// The agents' colours for a chart surface. The terminal wears each CLI's own brand colour, but two
// of those (codex's blue, kiro's lavender) are indistinguishable under protanopia and three sit too
// light for a chart; these are the same hue families where they could be kept, stepped per surface
// and validated for adjacent-pair separation in roster order (dataviz validate_palette, both modes).
const AGENT_CHART = {
  light: { claude: '#eb6834', codex: '#2a78d6', kiro: '#e87ba4', opencode: '#eda100', antigravity: '#1baf7a' },
  dark: { claude: '#d95926', codex: '#3987e5', kiro: '#d55181', opencode: '#c98500', antigravity: '#199e70' },
} as const

const vars = (mode: keyof typeof AGENT_CHART): string =>
  Object.entries(AGENT_CHART[mode])
    .map(([a, c]) => `--agent-${a}: ${c};`)
    .join(' ')

const LIGHT = `--surface: #fcfcfb; --surface-2: #f4f3ef; --line: #e4e2dc; --text: #0b0b0b; --text-2: #52514e; --muted: #8a887f; --accent: #2a78d6; ${vars('light')}`
const DARK = `--surface: #1a1a19; --surface-2: #232321; --line: #34332f; --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8d84; --accent: #3987e5; ${vars('dark')}`

const STYLE = `
  :root { color-scheme: light; ${LIGHT} }
  @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) { color-scheme: dark; ${DARK} } }
  :root[data-theme="dark"] { color-scheme: dark; ${DARK} }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: var(--surface); color: var(--text); }
  main { max-width: 960px; margin: 0 auto; padding: 2rem 1rem 4rem; }
  header { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { font-size: 1.35rem; margin: 0; }
  header .brand { color: var(--muted); font-weight: 600; letter-spacing: 0.02em; }
  header .asof { margin-left: auto; color: var(--muted); font-size: 12px; }
  h2 { font-size: 0.95rem; margin: 2.25rem 0 0.75rem; color: var(--text-2); font-weight: 600; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-top: 1.25rem; }
  .tile { background: var(--surface-2); border-radius: 10px; padding: 0.8rem 1rem; }
  .tile .label { color: var(--text-2); font-size: 12px; }
  .tile .value { font-size: 1.6rem; font-weight: 600; margin-top: 0.15rem; }
  .tile .value.hero { font-size: 2.6rem; line-height: 1.1; }
  .tile .sub { color: var(--muted); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 0.45rem 0.75rem 0.45rem 0; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; }
  td.prompt { color: var(--text-2); max-width: 26rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: var(--series, var(--accent)); margin-right: 0.45rem; vertical-align: 0; }
  .chart { width: 100%; height: auto; max-height: 190px; overflow: visible; }
  .chart .bar { fill: var(--accent); }
  .chart .target { fill: transparent; }
  .chart .hit:hover .bar, .chart .hit:focus .bar { opacity: 0.8; }
  .chart .hit:focus { outline: none; }
  .chart .axis { stroke: var(--line); stroke-width: 1; }
  .chart text { font-size: 10px; fill: var(--muted); }
  .agent-row { display: flex; align-items: center; gap: 0.75rem; margin: 0.35rem 0; }
  .agent-row svg { overflow: visible; max-width: calc(100% - 11rem); height: auto; }
  .agent-row rect { fill: var(--series, var(--accent)); }
  .agent-row rect:hover { opacity: 0.8; }
  .agent-label { width: 10.5rem; flex: none; display: flex; align-items: center; }
  .agent-label small { color: var(--muted); margin-left: auto; padding-right: 0.5rem; }
  .empty, .note { color: var(--muted); }
  .outcome-ok { color: var(--text-2); }
  #tip { position: fixed; pointer-events: none; background: var(--text); color: var(--surface); font-size: 12px; padding: 0.3rem 0.5rem; border-radius: 6px; opacity: 0; transition: opacity 80ms; white-space: nowrap; }
`

// One tooltip for every mark that carries a data-tip, on hover and on focus alike. The text goes in
// through textContent: agent names and dates are data, and data is never parsed as markup.
const SCRIPT = `
  const tip = document.getElementById('tip')
  const show = (el, x, y) => { tip.textContent = el.getAttribute('data-tip'); tip.style.left = (x + 12) + 'px'; tip.style.top = (y - 28) + 'px'; tip.style.opacity = 1 }
  document.addEventListener('pointermove', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el, e.clientX, e.clientY); else tip.style.opacity = 0 })
  document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (!el) return; const r = el.getBoundingClientRect(); show(el, r.left, r.top) })
  document.addEventListener('focusout', () => { tip.style.opacity = 0 })
`

function tiles(data: DashboardData): string {
  const t = data.totals
  const out = [
    `<div class="tile"><div class="label">Turns</div><div class="value hero">${compact(t.turns)}</div><div class="sub">${plural(data.agents.length, 'agent')}</div></div>`,
    `<div class="tile"><div class="label">Context sent</div><div class="value">${compact(t.inputTokens)}</div><div class="sub">tokens in</div></div>`,
    `<div class="tile"><div class="label">Output</div><div class="value">${compact(t.outputTokens)}</div><div class="sub">tokens out</div></div>`,
  ]
  if ((t.costUsd ?? 0) > 0) out.push(`<div class="tile"><div class="label">Reported spend</div><div class="value">$${(t.costUsd ?? 0).toFixed(2)}</div><div class="sub">where the CLI reports dollars</div></div>`)
  if ((t.credits ?? 0) > 0) out.push(`<div class="tile"><div class="label">Credits</div><div class="value">${(t.credits ?? 0).toFixed(2)}</div><div class="sub">where the CLI reports credits</div></div>`)
  if ((t.gateKnown ?? 0) > 0) out.push(`<div class="tile"><div class="label">Gate</div><div class="value">${t.gatePassed}/${t.gateKnown}</div><div class="sub">turns that passed</div></div>`)
  return `<section class="tiles">${out.join('')}</section>`
}

export function renderPage(data: DashboardData): string {
  const title = escape(data.title)

  const agentRows = data.agents
    .map(
      (a) => `<tr style="--series: var(--agent-${/^[a-z]+$/.test(a.agent) ? a.agent : 'none'}, var(--accent))">
        <td><i class="swatch"></i>${escape(a.agent)}</td>
        <td class="num">${a.turns}</td>
        <td class="num">${a.inputTokens.toLocaleString('en-US')}</td>
        <td class="num">${a.outputTokens.toLocaleString('en-US')}</td>
        <td class="num">${escape(a.spend)}</td>
        <td class="num">${usdCell(a)}</td>
      </tr>`,
    )
    .join('')

  const anyPriced = data.agents.some((a) => a.estimateUsd !== null)
  const recent = (data.recent ?? [])
    .map(
      (r) => `<tr style="--series: var(--agent-${/^[a-z]+$/.test(r.agent) ? r.agent : 'none'}, var(--accent))">
        <td>${escape(r.ago)}</td>
        <td><i class="swatch"></i>${escape(r.agent)}</td>
        <td class="${r.outcome === 'ok' ? 'outcome-ok' : ''}">${escape(r.outcome)}</td>
        <td class="num">${escape(r.took)}</td>
        <td class="prompt">${escape(r.prompt)}</td>
      </tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>konvoy - ${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><span class="brand">✻ konvoy</span><h1>${title}</h1><span class="asof">refresh to update</span></header>
${tiles(data)}

<h2>Per agent</h2>
<table>
<thead><tr><th>AGENT</th><th class="num">TURNS</th><th class="num">IN</th><th class="num">OUT</th><th class="num">SPEND</th><th class="num">~USD</th></tr></thead>
<tbody>${agentRows}</tbody>
</table>
<p class="note">spend is in each agent's own unit; a dash means the CLI reported none${anyPriced ? `. ~USD is estimated from rates configured as of ${escape(data.asOf || 'an unspecified date')}` : ''}</p>

<h2>Turns per day</h2>
${totalsBarsSvg(data.days)}

<h2>Turns per day by agent</h2>
${agentBarsSvg(data.byAgentDay)}
${recent ? `<h2>Latest turns</h2>
<table>
<thead><tr><th>WHEN</th><th>AGENT</th><th>OUTCOME</th><th class="num">TIME</th><th>PROMPT</th></tr></thead>
<tbody>${recent}</tbody>
</table>` : ''}
</main>
<div id="tip" role="tooltip"></div>
<script>${SCRIPT}</script>
</body>
</html>`
}
