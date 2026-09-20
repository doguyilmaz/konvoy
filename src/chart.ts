const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const DENSITY = ['·', '▫', '▪', '▩', '█'] as const
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function sparkline(values: number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values)
  // counts have a fixed baseline of zero, not the series' own minimum — a flat run of busy
  // days must render full, not empty. Guard only the case where there's no signal at all.
  if (max <= 0) return BLOCKS[0]!.repeat(values.length)
  return values.map((v) => BLOCKS[Math.round((v / max) * (BLOCKS.length - 1))]!).join('')
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
