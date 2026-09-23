import { expect, test } from 'bun:test'
import { antigravityAdapter } from '../src/adapters/antigravity'
import type { Binding, TurnContext } from '../src/types'

// Everything asserted here was verified against the installed agy 1.2.9 on 2026-09-23: the flags
// from `agy --help`, and the stream shape from two real turns captured into
// tests/fixtures/streams/antigravity*.jsonl. Google is transitioning gemini-cli to Antigravity CLI,
// and gemini-cli's own auth refuses this account's tier, so antigravity is the supported client.
const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId: 'konvoy-session',
  slug: 's',
  cwd: '/repo',
  sessionDir: '/repo/.konvoy/s',
  prompt: 'THEPROMPT',
  binding: null,
  effort: 'high',
  permission: 'edit',
  ...over,
})

const bound = (id: string): Binding => ({
  sessionId: 'x', agent: 'antigravity', foreignId: id, model: null, effort: 'high',
  permission: 'edit', status: 'bound', turns: 1, costUsd: 0, credits: 0, lastSeen: null,
})

test('a first turn runs agy headless with a streaming json output', () => {
  const cmd = antigravityAdapter.turn(ctx()).cmd
  expect(cmd[0]).toBe('agy')
  expect(cmd).toContain('--print')
  expect(cmd.join(' ')).toContain('--output-format stream-json')
  // agy assigns its own conversation id, so konvoy cannot preset one
  expect(antigravityAdapter.supportsPresetSessionId).toBe(false)
  expect(cmd.join(' ')).not.toContain('--conversation')
  expect(cmd[cmd.length - 1]).toBe('THEPROMPT')
})

test('a later turn resumes the conversation by the id konvoy captured', () => {
  const cmd = antigravityAdapter.turn(ctx({ binding: bound('73957e05-b711-49f7-8275-6859c958e170') })).cmd
  const at = cmd.indexOf('--conversation')
  expect(at).toBeGreaterThan(-1)
  expect(cmd[at + 1]).toBe('73957e05-b711-49f7-8275-6859c958e170')
})

test('effort and model travel as their own flags', () => {
  const cmd = antigravityAdapter.turn(ctx({ effort: 'low', model: 'gemini-3.8-flash-high' })).cmd
  expect(cmd.join(' ')).toContain('--effort low')
  expect(cmd.join(' ')).toContain('--model gemini-3.8-flash-high')
})

// `agy --help` offers `--mode accept-edits|plan` and `--dangerously-skip-permissions`, and no
// automatic-review mode: `auto` therefore lands where `edit` does, the same honest mapping kiro
// gets, rather than being quietly promoted to skipping every permission.
test('permission levels map onto the modes agy actually has', () => {
  const line = (permission: string) => antigravityAdapter.turn(ctx({ permission: permission as never })).cmd.join(' ')
  expect(line('safe')).toContain('--mode plan')
  expect(line('edit')).toContain('--mode accept-edits')
  expect(line('auto')).toBe(line('edit'))
  expect(line('yolo')).toContain('--dangerously-skip-permissions')
  expect(line('yolo')).not.toContain('--mode')
})

test('a minimal harness turns off slash command and skill expansion', () => {
  expect(antigravityAdapter.turn(ctx({ harness: 'minimal' })).cmd).toContain('--disable-slash-commands')
  expect(antigravityAdapter.turn(ctx({ harness: 'inherit' })).cmd).not.toContain('--disable-slash-commands')
})

test('the init event yields the conversation id konvoy binds to', () => {
  const events = antigravityAdapter.parse(
    JSON.stringify({ event: 'init', conversation_id: 'abc-123', init: { cwd: '/repo', tools: ['ask_question'] } }),
  )
  expect(events).toEqual([{ t: 'session', foreignId: 'abc-123' }])
})

test('an agent response arrives as text deltas, and a user_input step is not echoed back', () => {
  const text = antigravityAdapter.parse(
    JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'c', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'stored' },
    }),
  )
  expect(text).toEqual([{ t: 'text', text: 'stored' }])

  // konvoy already holds the prompt; the captures show a user_input step with no text_delta at
  // all, and this guard is what keeps that true if one ever arrives carrying the prompt back.
  expect(
    antigravityAdapter.parse(
      JSON.stringify({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } }),
    ),
  ).toEqual([])
  expect(
    antigravityAdapter.parse(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 0, state: 'DONE', step_type: 'user_input', text_delta: 'THEPROMPT' },
      }),
    ),
    'only an agent_response is the answer',
  ).toEqual([])
})

// The shape here is the captured one: step_type is `tool`, and the arguments and any error live
// under `tool_info`. A first version of this adapter guessed `tool_call` with a `tool_input` field
// and was wrong on both, which the captured stream caught.
test('a tool step is reported with what it touched, from tool_info', () => {
  const started = antigravityAdapter.parse(
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la /tmp' } },
      },
    }),
  )
  expect(started).toEqual([{ t: 'tool', name: 'run_command', status: 'start', detail: 'ls -la /tmp' }])

  const failed = antigravityAdapter.parse(
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: 'ls' }, error: { type: 'TOOL_ERROR', message: 'permission check failed' } },
      },
    }),
  )
  expect(failed).toEqual([{ t: 'tool', name: 'run_command', status: 'error', detail: 'ls' }])
})

// Captured live: with `--mode plan`, a tool needing a permission nobody can grant is auto-denied,
// the turn still reports SUCCESS, and the answer is empty. The reason is only on stderr, so
// without this konvoy would print nothing and call it a success.
test('an auto-denied tool is surfaced, because the turn succeeds with an empty answer', () => {
  const stderr =
    'jetski: no output produced \u2014 a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json'
  const warnings = antigravityAdapter.warnings?.(stderr) ?? []
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('"command" permission')
  expect(warnings[0]).toContain('nobody to prompt')
  expect(antigravityAdapter.warnings?.('')).toEqual([])
})

test('the tool capture reaches both a started and a failed tool line', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/antigravity-tool.jsonl').text()).trim().split('\n')
  const tools = lines.flatMap((l) => antigravityAdapter.parse(l)).filter((e) => e.t === 'tool')
  expect(tools.map((t) => (t as { status: string }).status)).toEqual(['start', 'error'])
  for (const t of tools) {
    expect((t as { name: string }).name).toBe('run_command')
    expect((t as { detail?: string }).detail).toContain('ls -la')
  }
})

test('the result carries the final text, the usage and the verdict', () => {
  const events = antigravityAdapter.parse(
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'c',
        status: 'SUCCESS',
        response: 'stored\n',
        num_turns: 1,
        usage: { input_tokens: 12864, output_tokens: 1514, thinking_tokens: 1513, cache_read_tokens: 0, total_tokens: 14378 },
      },
    }),
  )
  // The capture's own arithmetic decides this: input 12864 + output 1514 === total 14378, and
  // thinking 1513 sits INSIDE output. So thinking is not added to input, and cache reads are.
  expect(events).toEqual([
    { t: 'usage', inputTokens: 12864, outputTokens: 1514 },
    { t: 'done', final: 'stored\n' },
  ])
})

test('an ERROR result is an error, not an empty answer', () => {
  const events = antigravityAdapter.parse(
    JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', usage: { input_tokens: 1, output_tokens: 0 } } }),
  )
  const error = events.find((e) => e.t === 'error') as { message: string; kind: string } | undefined
  expect(error).toBeDefined()
  expect(events.some((e) => e.t === 'done')).toBe(false)
})

// Both captures are real: one successful turn, and the same conversation resumed. The resumed one
// is the proof of konvoy's central promise for this agent - the nonce stored in the first turn came
// back in the second, through the conversation id konvoy captured from `init`.
test('the captured stream parses into a session, streamed text and a completion', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/antigravity.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => antigravityAdapter.parse(l))
  expect(events.filter((e) => e.t === 'session')).toEqual([
    { t: 'session', foreignId: '73957e05-b711-49f7-8275-6859c958e170' },
  ])
  expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')).toBe('stored\n')
  expect(events.find((e) => e.t === 'done')).toEqual({ t: 'done', final: 'stored\n' })
  const usage = events.find((e) => e.t === 'usage') as { inputTokens: number; outputTokens: number }
  expect(usage.inputTokens).toBe(12864)
  expect(usage.outputTokens).toBe(1514)
})

test('the resumed capture proves a bound conversation carries its context', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/antigravity-resumed.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => antigravityAdapter.parse(l))
  const done = events.find((e) => e.t === 'done') as { final: string }
  // kv7x2 was stored in the first turn and asked for in the second
  expect(done.final.trim()).toBe('kv7x2')
  expect(events.filter((e) => e.t === 'session')).toEqual([
    { t: 'session', foreignId: '73957e05-b711-49f7-8275-6859c958e170' },
  ])
})

test('attach opens the conversation interactively, or a fresh one when unbound', () => {
  expect(antigravityAdapter.attach(bound('abc-123')).cmd).toEqual(['agy', '--conversation', 'abc-123'])
  expect(antigravityAdapter.attach({ ...bound('x'), foreignId: null }).cmd).toEqual(['agy'])
})

test('a line that is not json, or carries no event, is ignored rather than throwing', () => {
  expect(antigravityAdapter.parse('Fetching available models...')).toEqual([])
  expect(antigravityAdapter.parse('{}')).toEqual([])
  expect(antigravityAdapter.parse(JSON.stringify({ event: 'unknown_future_event' }))).toEqual([])
})

// Captured live: resuming a conversation that no longer exists does NOT fail. agy warns on stderr
// and silently starts a new conversation with a different id, so the turn succeeds having forgotten
// the session. konvoy's rebind logic keys on a crash, which never comes, so without this the
// context loss is completely silent.
test('a resume whose conversation is gone is surfaced, because agy starts a new one and succeeds', async () => {
  const warnings = antigravityAdapter.warnings?.('warning: conversation "00000000-0000-4000-8000-000000000000" not found') ?? []
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('00000000-0000-4000-8000-000000000000')
  expect(warnings[0]).toContain('no memory of the session')

  // the capture proves the shape: a new id in init, and a successful result
  const lines = (await Bun.file('tests/fixtures/streams/antigravity-missing.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => antigravityAdapter.parse(l))
  const session = events.find((e) => e.t === 'session') as { foreignId: string }
  expect(session.foreignId).not.toBe('00000000-0000-4000-8000-000000000000')
  expect(events.some((e) => e.t === 'done')).toBe(true)
})

test('both stderr warnings can arrive together, and both are reported', () => {
  const both =
    'warning: conversation "abc" not found\njetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.'
  expect(antigravityAdapter.warnings?.(both)).toHaveLength(2)
})
