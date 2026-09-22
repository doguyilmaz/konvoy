import { expect, test } from 'bun:test'
import { agentSparklines, heatmap, shareBars, sparkline } from '../src/chart'

test('a sparkline uses the full block range and scales to its own maximum', () => {
  expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█')
})

test('a busy flat series is full, not empty - the baseline is zero, not the minimum', () => {
  expect(sparkline([3, 3, 3])).toBe('███')
  expect(sparkline([5, 6, 7])).toBe('▆▇█')
  expect(sparkline([0, 0, 0])).toBe('▁▁▁')
  expect(sparkline([])).toBe('')
})

test('sparkline still self-scales to its own maximum when no explicit max is given', () => {
  expect(sparkline([1, 2, 4])).toBe('▃▅█')
})

test('an explicit max draws the same values differently than self-scaling would', () => {
  // against a shared max of 8, [1,2,4] tops out at the middle of the range, not the top
  expect(sparkline([1, 2, 4], 8)).toBe('▂▃▅')
  expect(sparkline([1, 2, 4], 8)).not.toBe(sparkline([1, 2, 4]))
})

test('agentSparklines draws every agent on one shared scale, not each against its own', () => {
  const rows = [
    { agent: 'claude', day: '2026-09-01', count: 40 },
    { agent: 'claude', day: '2026-09-02', count: 40 },
    { agent: 'codex', day: '2026-09-01', count: 2 },
    { agent: 'codex', day: '2026-09-02', count: 2 },
  ]
  const out = agentSparklines(rows)
  const claude = out.find((r) => r.agent === 'claude')!.line
  const codex = out.find((r) => r.agent === 'codex')!.line
  // claude is the busiest agent, so it renders at the top of the shared scale
  expect(claude).toBe('██')
  // codex is far quieter - on its OWN scale it would also render at the top; on the
  // scale shared with claude it must render near the bottom instead
  // two turns a day on a scale set by a much busier agent: near the bottom, but visible
  expect(codex).toBe('▂▂')
})

test('an agent idle in the middle of the range renders zeros there, and every row has the same length', () => {
  const rows = [
    { agent: 'claude', day: '2026-09-01', count: 5 },
    { agent: 'claude', day: '2026-09-05', count: 5 },
    { agent: 'codex', day: '2026-09-03', count: 5 },
  ]
  const out = agentSparklines(rows)
  const claude = out.find((r) => r.agent === 'claude')!.line
  const codex = out.find((r) => r.agent === 'codex')!.line
  expect(claude.length).toBe(5)
  expect(codex.length).toBe(5)
  // codex only turned on day 3 (the middle day) - every other day, including the ones
  // neither endpoint mentions, must still render as an explicit zero, not be dropped
  expect(claude).toBe('█▁▁▁█')
  expect(codex).toBe('▁▁█▁▁')
})

test('agentSparklines of nothing is nothing, not a crash', () => {
  expect(agentSparklines([])).toEqual([])
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
  // a week apart with nothing recorded in between - every day in that gap must still render
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

// Math.round((v / m) * 7) is 0 for any v below m/14, so a day with 7 turns beside a day with 100
// drew the same glyph as a day with none. heatmap in the same file uses Math.ceil for this
// reason; sparkline now floors any nonzero value at the first visible block.
test('a quiet but active day renders one block above zero, never as zero', () => {
  expect(sparkline([0, 7, 100])).toBe('▁▂█')
})
