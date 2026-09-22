const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const DENSITY = ['·', '▫', '▪', '▩', '█'] as const
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function sparkline(values: number[], max?: number): string {
  if (values.length === 0) return ''
  // an explicit max lets several series share one scale (see agentSparklines); omitted, a
  // series scales to its own peak, as a lone sparkline always has
  const m = max ?? Math.max(...values)
  // counts have a fixed baseline of zero, not the series' own minimum - a flat run of busy
  // days must render full, not empty. Guard only the case where there's no signal at all.
  if (m <= 0) return BLOCKS[0]!.repeat(values.length)
  // a nonzero count is never the zero glyph: below m/14 Math.round lands on 0, and a quiet day
  // must still read as a day with turns
  return values
    .map((v) => (v <= 0 ? BLOCKS[0]! : BLOCKS[Math.min(BLOCKS.length - 1, Math.max(1, Math.round((v / m) * (BLOCKS.length - 1))))]!))
    .join('')
}

export function shareBars(rows: { label: string; value: number }[], width = 18): string {
  const total = rows.reduce((sum, r) => sum + r.value, 0)
  const labelWidth = Math.max(...rows.map((r) => r.label.length), 1)
  return (
    rows
      .map((r) => {
        const share = total > 0 ? r.value / total : 0
        const filled = Math.round(share * width)
        const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
        return `${r.label.padEnd(labelWidth)}  ${bar}  ${Math.round(share * 100)}%`
      })
      .join('\n') + '\n'
  )
}

// a lone agent's sparkline can't reveal whether it's the busy one or the quiet one - every
// agent must be drawn against the same peak, and every row must span the same dense day
// range (gaps filled with zero) so the columns line up between agents
export function agentSparklines(rows: { agent: string; day: string; count: number }[]): { agent: string; line: string }[] {
  if (rows.length === 0) return []
  const days = [...new Set(rows.map((r) => r.day))].sort()
  const start = days[0]!
  const end = days[days.length - 1]!

  const denseDays: string[] = []
  for (
    const cursor = new Date(`${start}T00:00:00Z`);
    cursor <= new Date(`${end}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    denseDays.push(cursor.toISOString().slice(0, 10))
  }

  const byAgent = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, new Map())
    byAgent.get(r.agent)!.set(r.day, r.count)
  }

  const series = [...byAgent.entries()].map(([agent, dayCounts]) => ({
    agent,
    values: denseDays.map((d) => dayCounts.get(d) ?? 0),
  }))

  const sharedMax = Math.max(...series.flatMap((s) => s.values), 0)
  return series.map(({ agent, values }) => ({ agent, line: sparkline(values, sharedMax) }))
}

export function heatmap(days: { day: string; count: number }[]): string {
  if (days.length === 0) return ''
  const max = Math.max(...days.map((d) => d.count), 1)
  const byDay = new Map(days.map((d) => [d.day, d.count]))

  const first = new Date(`${days[0]!.day}T00:00:00Z`)
  const last = new Date(`${days[days.length - 1]!.day}T00:00:00Z`)
  const start = new Date(first)
  start.setUTCDate(start.getUTCDate() - start.getUTCDay())

  const rows: string[] = []
  for (let weekday = 0; weekday < 7; weekday++) {
    let line = `${DAY_LABELS[weekday]} `
    for (const cursor = new Date(start); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
      const cell = new Date(cursor)
      cell.setUTCDate(cell.getUTCDate() + weekday)
      const key = cell.toISOString().slice(0, 10)
      const count = byDay.get(key) ?? 0
      line += count === 0 ? DENSITY[0] : DENSITY[Math.min(DENSITY.length - 1, Math.ceil((count / max) * (DENSITY.length - 1)))]
    }
    rows.push(line)
  }
  return rows.join('\n')
}
