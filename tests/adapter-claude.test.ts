import { expect, test } from 'bun:test'
import { claudeAdapter } from '../src/adapters/claude'
import { classifyError } from '../src/adapters/types'
import type { Binding, TurnContext } from '../src/types'

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId: '11111111-2222-3333-4444-555555555555',
  slug: 'demo',
  cwd: '/repo',
  sessionDir: '/repo/.konvoy/demo',
  prompt: 'do the thing',
  binding: null,
  effort: 'high',
  permission: 'edit',
  ...over,
})

const bound = (foreignId: string): Binding => ({
  sessionId: '11111111-2222-3333-4444-555555555555',
  agent: 'claude',
  foreignId,
  model: null,
  effort: 'high',
  permission: 'edit',
  status: 'bound',
  turns: 1,
  costUsd: 0,
  credits: 0,
  lastSeen: null,
})

test('a first turn passes the konvoy session id as the claude session id', () => {
  const plan = claudeAdapter.turn(ctx())
  expect(plan.cmd).toContain('--session-id')
  expect(plan.cmd[plan.cmd.indexOf('--session-id') + 1]).toBe('11111111-2222-3333-4444-555555555555')
  expect(plan.cmd).toContain('-p')
  expect(plan.cmd).toContain('stream-json')
})

test('a later turn resumes instead of creating', () => {
  const plan = claudeAdapter.turn(ctx({ binding: bound('abc-123') }))
  expect(plan.cmd).toContain('--resume')
  expect(plan.cmd[plan.cmd.indexOf('--resume') + 1]).toBe('abc-123')
  expect(plan.cmd).not.toContain('--session-id')
})

test('the minimal harness strips the user plugin and mcp surface', () => {
  const cmd = claudeAdapter.turn(ctx()).cmd
  expect(cmd).toContain('--strict-mcp-config')
  expect(cmd).toContain('--disable-slash-commands')
  expect(claudeAdapter.turn(ctx({ harness: 'inherit' })).cmd).not.toContain('--strict-mcp-config')
})

test('permission levels map onto claude permission modes', () => {
  const mode = (p: 'safe' | 'edit' | 'yolo') => {
    const cmd = claudeAdapter.turn(ctx({ permission: p })).cmd
    return cmd[cmd.indexOf('--permission-mode') + 1]
  }
  expect(mode('safe')).toBe('manual')
  expect(mode('edit')).toBe('acceptEdits')
  expect(mode('yolo')).toBe('bypassPermissions')
})

test('the init line yields the session id', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })
  expect(claudeAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 'sess-1' }])
})

test('control bytes in the session id are stripped where it enters, not where it is printed', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess\x1b]0;pwned\x07-1' })
  expect(claudeAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 'sess]0;pwned-1' }])
})

test('assistant text is extracted and tool blocks are reported', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash' }] },
  })
  expect(claudeAdapter.parse(line)).toEqual([
    { t: 'text', text: 'hello' },
    { t: 'tool', name: 'Bash', status: 'start' },
  ])
})

test('the result line yields usage and completion together', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'all done',
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, output_tokens: 20 },
  })
  expect(claudeAdapter.parse(line)).toEqual([
    { t: 'usage', inputTokens: 10, outputTokens: 20, costUsd: 0.42 },
    { t: 'done', final: 'all done' },
  ])
})

test('an error result is classified', () => {
  const line = JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key' })
  expect(claudeAdapter.parse(line)).toEqual([{ t: 'error', message: 'Invalid API key', kind: 'auth' }])
})

test('a non-json line is ignored', () => {
  expect(claudeAdapter.parse('Loading...')).toEqual([])
})

test('hook chatter carries a session id but must not be mistaken for the init event', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'hook_started', session_id: 'sess-1', hook_name: 'x' })
  expect(claudeAdapter.parse(line)).toEqual([])
})

test('the captured fixture parses into session, text and completion', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/claude.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => claudeAdapter.parse(l))
  expect(events.filter((e) => e.t === 'session')).toHaveLength(1)
  expect(events.find((e) => e.t === 'done')).toEqual({ t: 'done', final: 'OK' })
})

test('attach resumes the bound session interactively', () => {
  const plan = claudeAdapter.attach(bound('abc-123'))
  expect(plan.cmd).toEqual(['claude', '--resume', 'abc-123'])
})

test('a prompt that begins with a dash survives argument parsing', () => {
  const cmd = claudeAdapter.turn(ctx({ prompt: '--force the refactor' })).cmd
  const sep = cmd.indexOf('--')
  expect(sep).toBeGreaterThan(-1)
  expect(cmd[sep + 1]).toBe('--force the refactor')
  expect(cmd[cmd.length - 1]).toBe('--force the refactor')
})

test('a malformed content block does not take the whole line down', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [null, { type: 'text', text: 'hi' }] } })
  expect(claudeAdapter.parse(line)).toEqual([{ t: 'text', text: 'hi' }])
})

test('thinking blocks are reported apart from message text', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })
  expect(claudeAdapter.parse(line)).toEqual([{ t: 'thinking', text: 'hmm' }])
})

test('attaching an unbound agent starts it fresh', () => {
  expect(claudeAdapter.attach({ ...bound('x'), foreignId: null }).cmd).toEqual(['claude'])
})

test('ordinary coding vocabulary is not mistaken for an auth failure', () => {
  expect(classifyError("cannot resolve module '../pages/login'")).toBe('unknown')
  expect(classifyError('OPENAI_API_KEY environment variable is not set')).toBe('unknown')
  expect(classifyError('Invalid API key')).toBe('auth')

  // Captured verbatim from the installed binaries on 2026-09-20. Expiry is phrased around
  // "session" or "token", never the word "credentials", which is what the pattern required.
  expect(classifyError('Cloud gateway session expired \u2014 run /login to reconnect.')).toBe('auth')
  expect(classifyError('AWS session has expired. Reauthenticating...')).toBe('auth')
  expect(classifyError('Login token is expired and cannot be refreshed')).toBe('auth')
  expect(classifyError('MCP OAuth access token is expired and refresh failed')).toBe('auth')
  expect(classifyError("Not signed in. Please run 'codex login' to sign in with ChatGPT.")).toBe('auth')
  expect(classifyError('OAuth token refresh failed: ')).toBe('auth')
  expect(classifyError('Unable to refresh token: No registered client was found')).toBe('auth')
  expect(classifyError('oauth token revoked')).toBe('auth')

  // a parser complaining about a token is not an auth failure
  expect(classifyError('SyntaxError: Unexpected token, expected ";"')).toBe('unknown')
  expect(classifyError('Invalid token in JSON at position 4')).toBe('unknown')
  expect(classifyError("Unexpected token '<' — the config file is invalid")).toBe('unknown')
  expect(classifyError('parse error at token 12: the trailing comma is invalid')).toBe('unknown')
  expect(classifyError('rate limit exceeded')).toBe('rate')

  // Captured verbatim from Claude Code on 2026-09-20 — the only real limit messages this
  // project has ever observed. Everything else in RATE is conjecture from other vendors.
  expect(classifyError("You've hit your weekly limit \u00b7 resets 7am (Europe/Istanbul)")).toBe('rate')
  expect(classifyError("You've hit your session limit \u00b7 resets 12:40am (Europe/Istanbul)")).toBe('rate')
  expect(classifyError('error type rate_limit')).toBe('rate')
  expect(classifyError('the upstream returned HTTP 429')).toBe('rate')

  // kiro-cli emits no rate-limit prose at all, only AWS exception type names
  expect(classifyError('ThrottlingException')).toBe('rate')
  expect(classifyError('TooManyRequestsException')).toBe('rate')
  // enum-ish spellings that carry no separator
  expect(classifyError('rateLimitExceeded')).toBe('rate')
  // codex's actual five-hour wording
  expect(classifyError('Remaining usage on the 5-hour usage limit')).toBe('rate')

  // conjectured phrasings, kept because they cost nothing and may match another CLI
  expect(classifyError('You have reached your usage limit. Your limit resets at 7pm.')).toBe('rate')
  expect(classifyError('Weekly limit reached')).toBe('rate')
  // a crash that merely contains the word "limit" must not read as a rate limit — these pin the
  // regex's precision, not just its reach, and a bare /limit/ has to fail them
  expect(classifyError('SyntaxError: near "LIMIT": syntax error')).toBe('unknown')
  expect(classifyError('EMFILE: too many open files, watch')).toBe('unknown')
  expect(classifyError('RangeError: Maximum call stack size exceeded')).toBe('unknown')
  expect(classifyError('ENOSPC: no space left on device, write')).toBe('unknown')
})

test('an API that is reachable but refusing is upstream, not a crash', () => {
  expect(classifyError('the service is at capacity')).toBe('upstream')
  expect(classifyError('Overloaded')).toBe('upstream')
  expect(classifyError('temporarily unavailable')).toBe('upstream')
  expect(classifyError('503 Service Unavailable')).toBe('upstream')
  expect(classifyError('server is busy, try again')).toBe('upstream')
  expect(classifyError('Internal Server Error')).toBe('upstream')
  expect(classifyError('upstream connect error')).toBe('upstream')

  // a rate limit is not an outage: it does not clear by retrying in seconds
  expect(classifyError("You've hit your weekly limit")).toBe('rate')
  // order matters: a message that is both rate-limited and mentions 503 is still a rate limit,
  // because that window is hours, not seconds
  expect(classifyError("You've hit your weekly limit — upstream also returned 503")).toBe('rate')
  // and ordinary failures stay where they were
  expect(classifyError('ENOENT: no such file or directory')).toBe('unknown')
  expect(classifyError('TypeError: cannot read property of undefined')).toBe('unknown')
})
