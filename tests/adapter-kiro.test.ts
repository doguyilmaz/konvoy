import { expect, test } from 'bun:test'
import { kiroAdapter } from '../src/adapters/kiro'
import type { Binding, TurnContext } from '../src/types'

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId: 'k-1', slug: 'demo', cwd: '/repo', sessionDir: '/repo/.konvoy/demo',
  prompt: 'do it', binding: null, effort: 'high', permission: 'edit', ...over,
})

const bound = (foreignId: string): Binding => ({
  sessionId: 'k-1', agent: 'kiro', foreignId, model: null, effort: 'high',
  permission: 'edit', status: 'bound', turns: 1, costUsd: 0, credits: 0, lastSeen: null,
})

test('the binary is kiro-cli, not kiro', () => {
  expect(kiroAdapter.bin).toBe('kiro-cli')
  expect(kiroAdapter.turn(ctx()).cmd[0]).toBe('kiro-cli')
})

test('a first turn runs a non-interactive stream-json chat', () => {
  const cmd = kiroAdapter.turn(ctx()).cmd
  expect(cmd).toContain('chat')
  expect(cmd).toContain('--no-interactive')
  expect(cmd.join(' ')).toContain('--output-format stream-json')
  expect(cmd).not.toContain('--resume-id')
})

test('a later turn resumes by id', () => {
  const cmd = kiroAdapter.turn(ctx({ binding: bound('sess_abc') })).cmd
  expect(cmd[cmd.indexOf('--resume-id') + 1]).toBe('sess_abc')
})

test('permission levels map onto tool trust', () => {
  expect(kiroAdapter.turn(ctx({ permission: 'yolo' })).cmd).toContain('--trust-all-tools')
  expect(kiroAdapter.turn(ctx({ permission: 'safe' })).cmd).toContain('--trust-tools=')
})

test('the session id is read from the envelope, not the top level', () => {
  const line = JSON.stringify({ type: 'metadata', data: { sessionId: 'sess_abc', contextUsagePercentage: 4.8 } })
  expect(kiroAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 'sess_abc' }])
})

test('control bytes in the session id are stripped where it enters', () => {
  const line = JSON.stringify({ type: 'metadata', data: { sessionId: 'sess\x1b]0;pwned\x07_abc' } })
  expect(kiroAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 'sess]0;pwned_abc' }])
})

test('a message chunk yields text', () => {
  const line = JSON.stringify({
    type: 'sessionUpdate',
    data: { sessionId: 'sess_abc', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
  })
  expect(kiroAdapter.parse(line)).toEqual([
    { t: 'session', foreignId: 'sess_abc' },
    { t: 'text', text: 'hi' },
  ])
})

test('a thought chunk is separated from message text', () => {
  const line = JSON.stringify({
    type: 'sessionUpdate',
    data: { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } },
  })
  expect(kiroAdapter.parse(line)).toEqual([
    { t: 'session', foreignId: 's' },
    { t: 'thinking', text: 'hmm' },
  ])
})

test('a metering field that is not an array is ignored rather than fatal', () => {
  const line = JSON.stringify({ type: 'metadata', data: { sessionId: 's', meteringUsage: { value: 5, unit: 'credit' } } })
  expect(kiroAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 's' }])
})

test('metering usage is reported in credits', () => {
  const line = JSON.stringify({
    type: 'metadata',
    data: { sessionId: 's', meteringUsage: [{ value: 0.0667, unit: 'credit' }] },
  })
  expect(kiroAdapter.parse(line)).toEqual([
    { t: 'session', foreignId: 's' },
    { t: 'usage', credits: 0.0667 },
  ])
})

test('runFinished carries the final text', () => {
  const line = JSON.stringify({
    type: 'runFinished',
    data: { sessionId: 's', status: 'success', stopReason: 'end_turn', finalText: 'OK' },
  })
  expect(kiroAdapter.parse(line)).toEqual([
    { t: 'session', foreignId: 's' },
    { t: 'done', final: 'OK' },
  ])
})

test('a failed run is an error, not a completion', () => {
  const line = JSON.stringify({ type: 'runFinished', data: { sessionId: 's', status: 'error', stopReason: 'refusal' } })
  const events = kiroAdapter.parse(line)
  expect(events[1]?.t).toBe('error')
})

test('the captured fixture parses end to end', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/kiro.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => kiroAdapter.parse(l))
  expect(events.find((e) => e.t === 'session')).toEqual({ t: 'session', foreignId: '4bf0ad64-fb09-4b5e-802e-b95909a00455' })
  expect(events.find((e) => e.t === 'done')).toEqual({ t: 'done', final: 'OK' })
  expect(events.some((e) => e.t === 'usage')).toBe(true)
})

test('attach resumes the session interactively', () => {
  expect(kiroAdapter.attach(bound('sess_abc')).cmd).toEqual(['kiro-cli', 'chat', '--resume-id', 'sess_abc'])
})
