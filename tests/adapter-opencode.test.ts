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

test('control bytes in the session id are stripped where it enters', () => {
  const line = JSON.stringify({ type: 'text', sessionID: 'ses\x1b]0;pwned\x07_x', part: { text: 'hi' } })
  expect(opencodeAdapter.parse(line)[0]).toEqual({ t: 'session', foreignId: 'ses_x' })
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

// The stream this replaced was captured from a turn that called no tools, and opencode only
// emits step_finish once a step does tool work — so the fixture never carried usage and this
// test asserted its absence as correct. That is how an unexercised branch reads as covered.
// This capture does call a tool: it carries cost and tokens, and pins both.
test('the captured v2 success stream parses into session, text, usage and cost', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/opencode.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => opencodeAdapter.parse(l))
  expect(events.filter((e) => e.t === 'session')[0]).toEqual({
    t: 'session',
    foreignId: 'ses_f3d905791ffecnY1rPhgZKHUWz',
  })
  expect(events.find((e) => e.t === 'text')).toEqual({ t: 'text', text: 'OK' })
  // re-captured against 2.0.11: input + cache.read + cache.write = 16596 — opencode's `input` is the uncached
  // remainder, as its own `total` arithmetic shows (input+output+cache = total). Whether its
  // `reasoning` count sits inside `output` is not established, so output is left untouched.
  expect(events.find((e) => e.t === 'usage')).toEqual({
    t: 'usage',
    inputTokens: 16596,
    outputTokens: 39,
    costUsd: 0.004976808,
  })
})

// Same rule as the other adapters: no invented "unknown error" standing between turn.ts and
// stderr when the stream's error carries no message.
test('an error event without a message reports an empty message, not a placeholder', () => {
  expect(opencodeAdapter.parse(JSON.stringify({ type: 'error', error: {} }))).toEqual([{ t: 'error', message: '', kind: 'unknown' }])
})
