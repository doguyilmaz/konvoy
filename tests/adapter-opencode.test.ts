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

// v2 removed `--variant`, so effort rides on the model reference instead. It is sent only for a
// model whose variants detection proved (see the T26 test below): this one names them explicitly.
test('effort rides on the model reference, because v2 removed --variant', () => {
  const cmd = opencodeAdapter.turn(
    ctx({ effort: 'max', model: 'opencode/claude-opus-4-8', efforts: ['high', 'max'] }),
  ).cmd
  expect(cmd[cmd.indexOf('-m') + 1]).toBe('opencode/claude-opus-4-8#max')
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
// emits step_finish once a step does tool work - so the fixture never carried usage and this
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
  // re-captured against 2.0.11: input + cache.read + cache.write = 16596 - opencode's `input` is the uncached
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

// Probed against opencode v2.0.11 on 2026-09-22. The binary reads OPENCODE_CONFIG (an explicit
// file), OPENCODE_CONFIG_CONTENT (inline), OPENCODE_CONFIG_DIR (the config directory) and
// OPENCODE_CONFIG_PROJECT_DISABLE. Only the last one removes a source: with the other three set
// every way round, `opencode debug config` still resolves ~/.config/opencode/opencode.json, so
// the explicit ones ADD a source to the merge rather than replacing the global config. `minimal`
// therefore means what it can mean here - the project's own config is not loaded - and konvoy
// must not claim more. Data, auth and the session db are untouched by all of them (`auth list`
// and `session list` unchanged), which is why relocating the config dir is not worth doing.
test('a minimal opencode turn stops the project config from loading', () => {
  const plan = opencodeAdapter.turn(ctx({ harness: 'minimal' }))
  expect(plan.env?.OPENCODE_CONFIG_PROJECT_DISABLE).toBe('1')
  // inherited, or the turn loses PATH and the credentials opencode resolves for itself
  expect(plan.env?.PATH).toBe(process.env.PATH)
})

test('an inherited opencode turn is handed no config environment at all', () => {
  const plan = opencodeAdapter.turn(ctx({ harness: 'inherit' }))
  expect(plan.env?.OPENCODE_CONFIG_PROJECT_DISABLE).toBeUndefined()
})

// From the real capture: a tool part carries `state.input`, which is the path or command the call
// acted on. Without it an opencode turn renders "read" with no indication of what it read.
test('an opencode tool part carries what it acted on', () => {
  const events = opencodeAdapter.parse(
    JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'package.json' } } },
    }),
  )
  expect(events).toEqual([{ t: 'tool', name: 'Read', status: 'ok', detail: 'package.json' }])

  const bash = opencodeAdapter.parse(
    JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'bun test' } } },
    }),
  )
  expect(bash).toEqual([{ t: 'tool', name: 'Bash', status: 'error', detail: 'bun test' }])
})

// Captured from a real smoke run on 2026-09-23: opencode refused every turn with
// "Upstream request failed: An active OpenCode Go subscription is required to use Go models."
// konvoy classified it `unknown`, which does NOT move the failover chain - so a convoy would sit
// on an agent that cannot work until someone pays, instead of handing the turn to another agent.
// An entitlement refusal is the same shape as auth by design section 16's own test: the agent
// cannot work until something outside the turn changes.
test('a subscription or entitlement refusal is an auth failure, so the chain moves off it', () => {
  const { classifyError } = require('../src/adapters/types') as { classifyError: (s: string) => string }
  expect(classifyError('Upstream request failed: An active OpenCode Go subscription is required to use Go models.')).toBe('auth')
  expect(classifyError('your subscription has expired')).toBe('auth')
  expect(classifyError('no active subscription for this account')).toBe('auth')
  // and the words stay narrow: ordinary prose about subscriptions is not an auth failure
  expect(classifyError('I added a subscription field to the user model')).toBe('unknown')
  expect(classifyError('the subscribe handler needs a test')).toBe('unknown')
})

// Captured live on 2026-09-23: opencode's error object names its own kind and HTTP status, which is
// authoritative where konvoy's prose matching is a guess. The message regex added for this case
// works, but only for this wording - `provider.auth` and 403 hold for any refusal opencode files
// that way, including ones nobody has written a pattern for yet.
test('an error that names its own kind is classified from that field, not from its prose', () => {
  const line = JSON.stringify({
    type: 'error',
    sessionID: 'ses_x',
    error: {
      type: 'provider.auth',
      message: 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.',
      status: 403,
    },
  })
  // a line carrying a sessionID emits the session event first, so find the error rather than
  // assuming its position
  const errorOf = (l: string) => opencodeAdapter.parse(l).find((e) => e.t === 'error')
  const kindOf = (l: string): string => {
    const e = errorOf(l)
    return e && e.t === 'error' ? e.kind : 'no error event'
  }
  const event = errorOf(line)
  expect(event && event.t === 'error' ? event.kind : null).toBe('auth')
  expect(event && event.t === 'error' ? event.message : '').toContain('subscription is required')

  // a 429 is a rate limit whatever the prose says, and an unrecognised field falls back to the text
  expect(kindOf(JSON.stringify({ type: 'error', error: { type: 'provider.rate', message: 'slow down please', status: 429 } }))).toBe('rate')
  expect(kindOf(JSON.stringify({ type: 'error', error: { type: 'provider.weird', message: 'something new', status: 500 } }))).toBe('upstream')
  // and a plain message with no fields still goes through the prose classifier
  expect(kindOf(JSON.stringify({ type: 'error', error: { message: 'not logged in' } }))).toBe('auth')
})

// T26. The variant is opencode's own syntax for effort (`-m provider/model#high`) and a model that
// does not have the named variant refuses the turn outright. konvoy therefore sends one only where
// the registry proved it exists; `efforts` carries that proof, and its three states are distinct.
test('the effort variant is sent only for a model known to have it', () => {
  const withVariants = opencodeAdapter.turn(
    ctx({ model: 'opencode/claude-opus-4-8', effort: 'high', efforts: ['low', 'medium', 'high'] }),
  ).cmd
  expect(withVariants.join(' ')).toContain('-m opencode/claude-opus-4-8#high')

  // known to have NONE: the model still runs, at its own default effort, which beats a refusal
  const noVariants = opencodeAdapter.turn(
    ctx({ model: 'opencode/claude-haiku-4-5', effort: 'high', efforts: [] }),
  ).cmd
  expect(noVariants.join(' ')).toContain('-m opencode/claude-haiku-4-5')
  expect(noVariants.join(' ')).not.toContain('#')

  // unknown is treated like none, because appending an unproven variant is what broke the turn
  const unknown = opencodeAdapter.turn(ctx({ model: 'opencode/who-knows', effort: 'high' })).cmd
  expect(unknown.join(' ')).toContain('-m opencode/who-knows')
  expect(unknown.join(' ')).not.toContain('#')

  // and with no model at all konvoy names neither a model nor a variant
  expect(opencodeAdapter.turn(ctx({ effort: 'high' })).cmd).not.toContain('-m')
})
