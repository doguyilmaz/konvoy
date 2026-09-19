import { expect, test } from 'bun:test'
import { duplicateModels, formatRoster, formatVersions, type RosterRow } from '../src/format'

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  agent: 'claude',
  status: 'bound',
  model: 'opus',
  effort: 'high',
  foreignId: 'abc',
  turns: 2,
  costUsd: 1.5,
  credits: 0,
  ...over,
})

test('the roster renders one aligned line per agent', () => {
  const out = formatRoster([row(), row({ agent: 'codex', model: 'gpt-6-astra', foreignId: null, status: 'unbound' })])
  const lines = out.trim().split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain('AGENT')
  expect(lines[1]).toContain('claude')
  expect(lines[2]).toContain('codex')
})

test('an unbound agent shows a dash instead of an id', () => {
  expect(formatRoster([row({ foreignId: null })])).toContain('-')
})

test('cost is shown in the unit the agent actually reports, or not at all', () => {
  expect(formatRoster([row({ costUsd: 1.5, credits: 0 })])).toContain('$1.50')
  expect(formatRoster([row({ costUsd: 0, credits: 0.0667 })])).toContain('0.067 cr')
  expect(formatRoster([row({ costUsd: 0, credits: 0 })])).toContain('-')
})

test('agents sharing one model are reported as duplicates', () => {
  const dupes = duplicateModels([
    row({ agent: 'claude', model: 'claude-opus-5' }),
    row({ agent: 'kiro', model: 'claude-opus-5' }),
    row({ agent: 'codex', model: 'gpt-6-astra' }),
  ])
  expect(dupes).toEqual(['claude-opus-5'])
})

test('distinct models produce no duplicate warning', () => {
  expect(duplicateModels([row({ model: 'a' }), row({ agent: 'codex', model: 'b' })])).toEqual([])
})

test('versions render one line per agent including missing ones', () => {
  const out = formatVersions([
    { agent: 'claude', installed: true, version: '2.1.278', authed: true },
    { agent: 'codex', installed: false, version: null, authed: null },
  ])
  expect(out).toContain('claude')
  expect(out).toContain('2.1.278')
  expect(out).toContain('not installed')
})
