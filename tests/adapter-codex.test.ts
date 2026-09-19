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

test('the captured fixture parses into session, text and usage', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/codex.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => codexAdapter.parse(l))
  expect(events.find((e) => e.t === 'session')).toEqual({ t: 'session', foreignId: '01a0ba11-6f0b-7c13-bef4-224bd38f77a0' })
  expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')).toBe('OK')
  expect(events.some((e) => e.t === 'usage')).toBe(true)
})

test('attach resumes the thread interactively', () => {
  expect(codexAdapter.attach(bound('thread-9')).cmd).toEqual(['codex', 'resume', 'thread-9'])
})
