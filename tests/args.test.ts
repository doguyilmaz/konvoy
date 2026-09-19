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
