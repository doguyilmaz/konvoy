import type { AgentId } from './types'
import type { UsageRow } from './store/queries'
import { estimateAgentUsd, isPricingConfigured, type ModelUsage, type Pricing } from './pricing'
import { tokens } from './render'
import { agentPaint, colorEnabled, palette } from './style'

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

// The terminal decision, made once at a command's edge and passed down: a formatter never reads
// it, so the same arguments always produce the same bytes. stdout, because that is where a table
// goes and `konvoy usage > file` must hold plain text.
export const outputColor = (): boolean => colorEnabled(Bun.env, Boolean(process.stdout.isTTY))

export interface TableOptions {
  /** indexes of columns holding numbers: padded on the left, so they end on one column */
  right?: readonly number[]
  /** default false: a formatter is pure, so the terminal decision is made by the caller */
  color?: boolean
}

const STATUS_COLOR: Record<string, keyof ReturnType<typeof palette>> = {
  auth_required: 'red',
  'not installed': 'red',
  disabled: 'yellow',
  unbound: 'yellow',
  bound: 'green',
  ok: 'green',
  'login required': 'red',
  unknown: 'yellow',
}

// One table for every command konvoy prints. Width is computed on the PLAIN text and the paint is
// applied after padding, so colour can never shift a column. A column that is empty in every row
// is dropped rather than left as a header with nothing under it.
export function table(header: readonly string[], rows: readonly string[][], opts: TableOptions = {}): string {
  const color = opts.color ?? false
  const p = palette(color)
  const paintAgent = agentPaint(color)
  const keep = header.map((_, i) => rows.length === 0 || rows.some((r) => (r[i] ?? '') !== ''))
  const cols = header.map((_, i) => i).filter((i) => keep[i])
  const widths = cols.map((i) => Math.max(header[i]!.length, ...rows.map((r) => (r[i] ?? '').length)))
  const right = new Set(opts.right ?? [])

  const paint = (value: string, col: number): string => {
    if (!color || value === '' || value === '-') return value
    if (col === 0 && header[0] === 'AGENT') return paintAgent(value)(value)
    const named = STATUS_COLOR[value]
    return named ? p[named](value) : value
  }

  const line = (cells: readonly string[], paintCell: (v: string, c: number) => string): string =>
    cols
      .map((col, slot) => {
        const raw = cells[col] ?? ''
        const pad = ' '.repeat(Math.max(0, widths[slot]! - raw.length))
        const painted = paintCell(raw, col)
        return right.has(col) ? `${pad}${painted}` : `${painted}${pad}`
      })
      .join('  ')
      .trimEnd()

  const head = line(header, (v) => p.dim(v))
  return [head, ...rows.map((r) => line(r, paint))].join('\n') + '\n'
}

export function formatRoster(rows: RosterRow[], color = false): string {
  return table(
    ['AGENT', 'STATUS', 'MODEL', 'EFFORT', 'SESSION', 'TURNS', 'COST'],
    rows.map((r) => [r.agent, r.status, r.model || '-', r.effort, r.foreignId ?? '-', String(r.turns), cost(r)]),
    { right: [5, 6], color },
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

export function formatUsage(rows: UsageRow[], pricing?: Pricing, modelRows: ModelUsage[] = [], color = false): string {
  const showUsd = pricing !== undefined && isPricingConfigured(pricing)
  const header = ['AGENT', 'TURNS', 'IN', 'OUT', 'SPEND', ...(showUsd ? ['~USD'] : []), 'GATE']
  return table(
    header,
    rows.map((r) => [
      r.agent,
      String(r.turns),
      tokens(r.inputTokens),
      tokens(r.outputTokens),
      spend(r),
      ...(showUsd ? [usdCell(r, modelRows, pricing!)] : []),
      r.gateKnown > 0 ? `${r.gatePassed}/${r.gateKnown}` : '-',
    ]),
    // turns, in, out and both spend columns are numbers: they end on one column
    { right: showUsd ? [1, 2, 3, 4, 5] : [1, 2, 3, 4], color },
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

export function formatVersions(rows: AgentStatusRow[], color = false): string {
  return table(
    ['AGENT', 'VERSION', 'AUTH', 'DETAIL'],
    rows.map((r) => [
      r.agent,
      r.installed ? (r.version ?? 'unknown') : 'not installed',
      r.authed === null ? 'unknown' : r.authed ? 'ok' : 'login required',
      r.detail ?? '',
    ]),
    { color },
  )
}
