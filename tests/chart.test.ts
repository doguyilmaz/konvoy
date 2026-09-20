import { expect, test } from 'bun:test'
import { heatmap, shareBars, sparkline } from '../src/chart'

test('a sparkline uses the full block range and scales to its own maximum', () => {
  expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█')
})

test('a busy flat series is full, not empty — the baseline is zero, not the minimum', () => {
  expect(sparkline([3, 3, 3])).toBe('███')
  expect(sparkline([5, 6, 7])).toBe('▆▇█')
  expect(sparkline([0, 0, 0])).toBe('▁▁▁')
  expect(sparkline([])).toBe('')
})

test('share bars are proportional and labelled with the percentage', () => {
  const out = shareBars([
    { label: 'claude', value: 75 },
    { label: 'codex', value: 25 },
  ])
  const lines = out.trim().split('\n')
  expect(lines[0]).toContain('claude')
  expect(lines[0]).toContain('75%')
  expect(lines[1]).toContain('25%')
  expect((lines[0]!.match(/█/g) ?? []).length).toBeGreaterThan((lines[1]!.match(/█/g) ?? []).length)
})

test('share bars of nothing say so instead of dividing by zero', () => {
  expect(shareBars([{ label: 'claude', value: 0 }])).toContain('0%')
})

test('a heatmap lays days down and weeks across', () => {
  const days = Array.from({ length: 14 }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, '0')}`,
    count: i,
  }))
  const out = heatmap(days)
  expect(out.split('\n').length).toBeGreaterThanOrEqual(7)
  expect(out).toContain('Mon')
})

test('an empty heatmap is empty, not a crash', () => {
  expect(heatmap([])).toBe('')
})

test('a heatmap fills the gap between two recorded days as zero, not as missing', () => {
  // a week apart with nothing recorded in between — every day in that gap must still render
  // as a zero cell so every row stays the same width; dropping it would shift later columns left
  const days = [
    { day: '2026-09-01', count: 5 },
    { day: '2026-09-08', count: 5 },
  ]
  const out = heatmap(days)
  const lines = out.split('\n')
  const widths = new Set(lines.map((l) => l.length))
  expect(widths.size).toBe(1)
  expect(out).toContain('·')
})
