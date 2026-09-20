import { expect, test } from 'bun:test'
import { parseArgs } from '../src/args'

test('positionals and long flags are separated', () => {
  const a = parseArgs(['send', 'codex', 'fix the bug', '--session', 'auth'])
  expect(a._).toEqual(['send', 'codex', 'fix the bug'])
  expect(a.flags.session).toBe('auth')
})

test('a flag without a value is boolean true', () => {
  expect(parseArgs(['status', '--json']).flags.json).toBe(true)
})

test('an equals form is supported', () => {
  expect(parseArgs(['status', '--session=auth']).flags.session).toBe('auth')
})

test('a flag followed by another flag stays boolean', () => {
  const a = parseArgs(['ls', '--all', '--json'])
  expect(a.flags.all).toBe(true)
  expect(a.flags.json).toBe(true)
})

test('short flags are supported', () => {
  expect(parseArgs(['ledger', '-f']).flags.f).toBe(true)
})

test('everything after a bare double dash is positional', () => {
  const a = parseArgs(['send', 'codex', '--', '--force the refactor'])
  expect(a._).toEqual(['send', 'codex', '--force the refactor'])
  expect(Object.keys(a.flags)).toHaveLength(0)
})

test('a lone dash is a positional, not a flag', () => {
  expect(parseArgs(['send', 'codex', '-'])._).toEqual(['send', 'codex', '-'])
})

// `konvoy rm --yes <slug>` printed the usage line while `konvoy rm <slug> --yes` worked: a flag
// swallowed the positional after it as its value. Flags that are switches never take one.
test('a switch never swallows the positional that follows it; a value flag still takes its value', () => {
  expect(parseArgs(['rm', '--yes', 'doomed'])).toEqual({ _: ['rm', 'doomed'], flags: { yes: true } })
  expect(parseArgs(['config', 'set', '--global', 'defaults.effort', 'low'])).toEqual({ _: ['config', 'set', 'defaults.effort', 'low'], flags: { global: true } })
  expect(parseArgs(['usage', '--all', '--chart'])).toEqual({ _: ['usage'], flags: { all: true, chart: true } })
  expect(parseArgs(['dashboard', '--port', '4000'])).toEqual({ _: ['dashboard'], flags: { port: '4000' } })
  expect(parseArgs(['send', 'codex', '--session', 'demo', 'hello'])).toEqual({ _: ['send', 'codex', 'hello'], flags: { session: 'demo' } })
})
