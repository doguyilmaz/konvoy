import { expect, test } from 'bun:test'
import { codexAdapter } from '../src/adapters/codex'
import type { Binding, TurnContext } from '../src/types'

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId: 'k-1', slug: 'demo', cwd: '/repo', sessionDir: '/repo/.konvoy/demo',
  prompt: 'do it', binding: null, effort: 'high', permission: 'edit', ...over,
})

const bound = (foreignId: string): Binding => ({
  sessionId: 'k-1', agent: 'codex', foreignId, model: null, effort: 'high',
  permission: 'edit', status: 'bound', turns: 1, costUsd: 0, credits: 0, lastSeen: null,
})

test('a first turn runs codex exec with json output and an isolated config', () => {
  const cmd = codexAdapter.turn(ctx()).cmd
  expect(cmd.slice(0, 2)).toEqual(['codex', 'exec'])
  expect(cmd).toContain('--json')
  expect(cmd).toContain('--ignore-user-config')
  expect(cmd).not.toContain('resume')
})

test('a later turn resumes the thread by id', () => {
  const cmd = codexAdapter.turn(ctx({ binding: bound('thread-9') })).cmd
  expect(cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
  expect(cmd).toContain('thread-9')
})

test('effort travels as a config override, not a flag', () => {
  expect(codexAdapter.turn(ctx({ effort: 'max' })).cmd.join(' ')).toContain('model_reasoning_effort=max')
})

test('permission levels map onto sandbox modes', () => {
  const sandbox = (p: 'safe' | 'edit' | 'yolo') => {
    const cmd = codexAdapter.turn(ctx({ permission: p })).cmd
    const i = cmd.indexOf('-s')
    return i >= 0 ? cmd[i + 1] : cmd.find((c) => c.startsWith('--dangerously'))
  }
  expect(sandbox('safe')).toBe('read-only')
  expect(sandbox('edit')).toBe('workspace-write')
  expect(sandbox('yolo')).toBe('--dangerously-bypass-approvals-and-sandbox')
})

test('thread.started yields the session id', () => {
  expect(codexAdapter.parse('{"type":"thread.started","thread_id":"t-9"}')).toEqual([
    { t: 'session', foreignId: 't-9' },
  ])
})

test('control bytes in the thread id are stripped where it enters', () => {
  const line = JSON.stringify({ type: 'thread.started', thread_id: 't\x1b]0;pwned\x07-9' })
  expect(codexAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 't-9' }])
})

test('an agent message is text, never a terminal event', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'OK' } })
  expect(codexAdapter.parse(line)).toEqual([{ t: 'text', text: 'OK' }])
})

test('an item error is reported without claiming the turn failed', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Skill descriptions were shortened' } })
  expect(codexAdapter.parse(line)).toEqual([
    { t: 'error', message: 'Skill descriptions were shortened', kind: 'unknown' },
  ])
})

test('other completed items are reported as tool activity', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: ['ls'] } })
  expect(codexAdapter.parse(line)).toEqual([{ t: 'tool', name: 'command_execution', status: 'ok' }])
})

test('turn.completed yields usage', () => {
  const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 18173, output_tokens: 5 } })
  expect(codexAdapter.parse(line)).toEqual([{ t: 'usage', inputTokens: 18173, outputTokens: 5 }])
})

test('the captured fixture parses into session, tool call, text, notice and usage', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/codex.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => codexAdapter.parse(l))
  expect(events.find((e) => e.t === 'session')).toEqual({ t: 'session', foreignId: '01a0c0d3-eeba-7a93-8999-d74b91dcd5df' })
  expect(events.filter((e) => e.t === 'tool')).toEqual([{ t: 'tool', name: 'command_execution', status: 'ok' }])
  expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')).toBe('I’ll read package.json now.OK')
  // codex reports its skills-context-budget notice as an item of type "error" on a turn that
  // then completes normally; it must stay unclassified (kind unknown) so turn.ts can clear it —
  // a notice whose wording matched RATE or AUTH would otherwise trip failover on a healthy turn
  expect(events.filter((e) => e.t === 'error').map((e) => (e as { kind: string }).kind)).toEqual(['unknown'])
  expect(events.some((e) => e.t === 'usage')).toBe(true)
})

test('attach resumes the thread interactively', () => {
  expect(codexAdapter.attach(bound('thread-9')).cmd).toEqual(['codex', 'resume', 'thread-9'])
})

// An error event with no words must say nothing rather than invent "unknown error" or
// "turn failed": turn.ts reads stderr only when the stream's error is empty, so a placeholder
// hides the CLI's real reason (see the claude dead-session case in tests/session.test.ts).
test('an error item or a failed turn without a message reports an empty message, not a placeholder', () => {
  expect(codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: { type: 'error' } }))).toEqual([{ t: 'error', message: '', kind: 'unknown' }])
  expect(codexAdapter.parse(JSON.stringify({ type: 'turn.failed', error: {} }))).toEqual([{ t: 'error', message: '', kind: 'unknown' }])
})
