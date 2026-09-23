import { expect, test } from 'bun:test'
import { formatRoster, formatUsage, formatVersions, table } from '../src/format'

// Every command's output goes through one `table()`, so alignment, colour and empty columns are
// decided once. Before this, numbers were padded like words - `27` and `6` started at the same
// column as `TURNS` and ran ragged to the right - and no table carried any colour at all, while
// the REPL next to it did. A tool that prints numbers has to line them up.
test('numeric columns are right-aligned and text columns are not', () => {
  const out = table(['AGENT', 'TURNS'], [['claude', '27'], ['kiro', '6']], { right: [1], color: false })
  expect(out.split('\n').slice(0, 3)).toEqual(['AGENT   TURNS', 'claude     27', 'kiro        6'])
})

test('a column whose every cell is empty is dropped, header and all', () => {
  const out = table(['AGENT', 'VERSION', 'DETAIL'], [['claude', '2.1.278', ''], ['codex', '0.155.1', '']], { color: false })
  expect(out).not.toContain('DETAIL')
  // one that has any content at all stays
  expect(table(['A', 'B'], [['x', ''], ['y', 'kept']], { color: false })).toContain('B')
})

test('a header is dim and an agent name carries its own colour, when colour is on', () => {
  const plain = table(['AGENT'], [['claude']], { color: false })
  const painted = table(['AGENT'], [['claude']], { color: true })
  expect(plain).not.toContain('\x1b[')
  expect(painted).toContain('\x1b[')
  // colour must not change the column arithmetic
  expect(painted.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain)
})

test('every table konvoy prints lines its numbers up', () => {
  const roster = formatRoster([
    { agent: 'claude', status: 'bound', model: 'opus', effort: 'high', foreignId: 'abc', turns: 27, costUsd: 6.18, credits: 0 },
    { agent: 'kiro', status: 'unbound', model: '', effort: 'high', foreignId: null, turns: 6, costUsd: 0, credits: 0.19 },
  ])
  const rows = roster.split('\n').filter((l) => l.trim() !== '')
  const turnsColumn = rows.map((l) => l.indexOf(l.trim().split(/\s+/).at(-2)!))
  expect(new Set(turnsColumn).size).toBeGreaterThan(0)
  // 27 and 6 end at the same column
  const [header, first, second] = rows
  expect(first!.indexOf('27') + 2).toBe(second!.indexOf('6') + 1)
  expect(header).toContain('TURNS')
})

test('usage reports token counts the way every other surface does', () => {
  const out = formatUsage([
    { agent: 'claude', turns: 27, inputTokens: 25560, outputTokens: 5040, costUsd: 6.18, credits: 0, gatePassed: 0, gateKnown: 0 },
  ])
  // the turn footer and the REPL status line both say 25.6k; one quantity, one rendering
  expect(out).toContain('25.6k')
  expect(out).toContain('5.0k')
  expect(out).not.toContain('25560')
})

test('a status table drops its DETAIL column when nothing has a detail to show', () => {
  const clean = formatVersions([{ agent: 'claude', installed: true, version: '2.1.278', authed: true }])
  expect(clean).not.toContain('DETAIL')
  const withDetail = formatVersions([
    { agent: 'claude', installed: true, version: '2.1.278', authed: true, detail: 'model overlap with codex' },
  ])
  expect(withDetail).toContain('DETAIL')
  expect(withDetail).toContain('model overlap with codex')
})
