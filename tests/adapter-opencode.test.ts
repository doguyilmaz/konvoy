import { expect, test } from 'bun:test'
import { opencodeAdapter } from '../src/adapters/opencode'
import type { Binding, TurnContext } from '../src/types'

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId: 'k-1', slug: 'demo', cwd: '/repo', sessionDir: '/repo/.konvoy/demo',
  prompt: 'do it', binding: null, effort: 'high', permission: 'edit', ...over,
})

const bound = (foreignId: string): Binding => ({
  sessionId: 'k-1', agent: 'opencode', foreignId, model: null, effort: 'high',
  permission: 'edit', status: 'bound', turns: 1, costUsd: 0, credits: 0, lastSeen: null,
})

test('a first turn runs with json output and a konvoy title', () => {
  const cmd = opencodeAdapter.turn(ctx()).cmd
  expect(cmd.slice(0, 2)).toEqual(['opencode', 'run'])
  expect(cmd.join(' ')).toContain('--format json')
  expect(cmd[cmd.indexOf('--title') + 1]).toBe('konvoy:demo')
})

test('a later turn continues the session and drops the title', () => {
  const cmd = opencodeAdapter.turn(ctx({ binding: bound('ses_x') })).cmd
  expect(cmd[cmd.indexOf('-s') + 1]).toBe('ses_x')
  expect(cmd).not.toContain('--title')
})

test('effort rides on the model reference, because v2 removed --variant', () => {
  const cmd = opencodeAdapter.turn(ctx({ effort: 'max', model: 'opencode/claude-haiku-4-5' })).cmd
  expect(cmd[cmd.indexOf('-m') + 1]).toBe('opencode/claude-haiku-4-5#max')
  expect(cmd).not.toContain('--variant')
})

test('effort is silently unavailable when no model is configured', () => {
  const cmd = opencodeAdapter.turn(ctx({ effort: 'max' })).cmd
  expect(cmd).not.toContain('-m')
})

test('turns run against a private server so per-session config is honoured', () => {
  expect(opencodeAdapter.turn(ctx()).cmd).toContain('--standalone')
})

test('yolo enables auto-approval and safe does not', () => {
  expect(opencodeAdapter.turn(ctx({ permission: 'yolo' })).cmd).toContain('--auto')
  expect(opencodeAdapter.turn(ctx({ permission: 'safe' })).cmd).not.toContain('--auto')
})

test('the error message is read from error.data.message', async () => {
  const line = (await Bun.file('tests/fixtures/streams/opencode-error.jsonl').text()).trim()
  const events = opencodeAdapter.parse(line)
  expect(events[0]).toEqual({ t: 'session', foreignId: 'ses_f45edb4b4ffeq4ltAEt3M53XQo' })
  expect(events[1]?.t).toBe('error')
  expect((events[1] as { message: string }).message).toContain('1.18.0 or newer')
})

test('a plain error.message is still understood', () => {
  const line = JSON.stringify({ type: 'error', sessionID: 'ses_x', error: { message: 'rate limit exceeded' } })
  expect(opencodeAdapter.parse(line)).toEqual([
    { t: 'session', foreignId: 'ses_x' },
    { t: 'error', message: 'rate limit exceeded', kind: 'rate' },
  ])
})

test('text parts are extracted', () => {
  const line = JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { text: 'hello' } })
  expect(opencodeAdapter.parse(line)).toEqual([
    { t: 'session', foreignId: 'ses_x' },
    { t: 'text', text: 'hello' },
  ])
})

test('attach opens the session interactively', () => {
  expect(opencodeAdapter.attach(bound('ses_x')).cmd).toEqual(['opencode', '--session', 'ses_x'])
})

test('the captured v2 success stream parses into session and text', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/opencode.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => opencodeAdapter.parse(l))
  expect(events.filter((e) => e.t === 'session')[0]).toEqual({
    t: 'session',
    foreignId: 'ses_f45d589c0ffeLKBxthq8xnenN2',
  })
  expect(events.find((e) => e.t === 'text')).toEqual({ t: 'text', text: 'OK' })
  expect(events.some((e) => e.t === 'usage')).toBe(false)
})
