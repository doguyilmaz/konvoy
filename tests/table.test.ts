import { expect, test } from 'bun:test'
import { formatRoster, formatUsage, formatVersions, outputColor, table } from '../src/format'

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
  const header = ['AGENT', 'STATUS', 'TURNS'] as const
  // names of different lengths, each painted, with columns after them: if the paint is applied
  // before the padding is measured, every column after a coloured cell shifts by the length of
  // the escape sequence, and stripping the colour back out no longer matches the plain render.
  const rows = [
    ['claude', 'bound', '27'],
    ['opencode', 'auth_required', '6'],
  ]
  const plain = table(header, rows, { right: [2], color: false })
  const painted = table(header, rows, { right: [2], color: true })

  expect(plain).not.toContain('\x1b[')
  expect(painted).toContain('\x1b[')
  expect(painted.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain)
  // the colour is on the things worth distinguishing, not sprayed over the table
  expect(painted).toContain('\x1b[2mAGENT')
  expect(painted.split('\x1b[').length).toBeGreaterThan(5)
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

// A formatter is a pure function and must not read the terminal: `table()` defaulted its colour to
// `process.stdout.isTTY`, so the bytes formatRoster returned depended on how the process was
// started - the same call plain under a pipe and coloured under a terminal. Tests then pass or
// fail by invocation (this one fails under a pty and passes piped, before the fix), and any future
// caller that forgets the argument gets escape codes it never asked for. The decision belongs at
// the edge: each command resolves it from the environment and passes it in.
test('a formatter with no colour decision is plain, however the process was started', () => {
  const rows = [
    { agent: 'claude' as const, status: 'bound', model: 'opus', effort: 'high', foreignId: 'abc', turns: 27, costUsd: 6.18, credits: 0 },
  ]
  for (const out of [
    formatRoster(rows),
    formatUsage([{ agent: 'claude' as const, turns: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.1, credits: 0, gatePassed: 0, gateKnown: 0 }]),
    formatVersions([{ agent: 'claude' as const, installed: true, version: '2.1.204', authed: true }]),
    table(['AGENT'], [['claude']]),
  ]) {
    expect(out).not.toContain('\x1b[')
  }

  // and the colour is still available to whoever asks for it explicitly
  expect(formatRoster(rows, true)).toContain('\x1b[')
})

// The two invariants above need to be observable, and the suite's own preload sets NO_COLOR, which
// would make a formatter that reads the terminal look identical to one that does not. FORCE_COLOR
// short-circuits the TTY check (src/style.ts), so these pin both halves without depending on how
// the process was started: the formatter must stay plain even where colour is available, and the
// edge helper must be the thing that says yes.
test('a formatter stays plain even where colour is available, and the edge helper is what says yes', () => {
  const before = { no: Bun.env.NO_COLOR, force: Bun.env.FORCE_COLOR }
  try {
    delete Bun.env.NO_COLOR
    Bun.env.FORCE_COLOR = '1'
    // the formatter asked for no colour, so it gets none, whatever the environment offers
    expect(table(['AGENT'], [['claude']])).not.toContain('\x1b[')
    expect(formatRoster([
      { agent: 'claude', status: 'bound', model: 'opus', effort: 'high', foreignId: 'abc', turns: 1, costUsd: 0.1, credits: 0 },
    ])).not.toContain('\x1b[')
    // and the command edge resolves the environment's answer, which here is yes
    expect(outputColor()).toBe(true)
    expect(table(['AGENT'], [['claude']], { color: outputColor() })).toContain('\x1b[')

    // NO_COLOR outranks it, which is what a user who turned colour off expects
    Bun.env.NO_COLOR = '1'
    expect(outputColor()).toBe(false)
  } finally {
    if (before.no === undefined) delete Bun.env.NO_COLOR
    else Bun.env.NO_COLOR = before.no
    if (before.force === undefined) delete Bun.env.FORCE_COLOR
    else Bun.env.FORCE_COLOR = before.force
  }
})
