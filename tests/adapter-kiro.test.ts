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
  expect(kiroAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 'sess_abc' }])
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

test('the captured fixture parses end to end, tool call included', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/kiro.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => kiroAdapter.parse(l))
  expect(events.find((e) => e.t === 'session')).toEqual({ t: 'session', foreignId: '86db2fac-b93f-472f-98d0-17bb389144de' })
  // tool_call then tool_call_update for the same fs_read - kiro titles them, so the name is
  // the title, and both the start and the completion carry it
  expect(events.filter((e) => e.t === 'tool')).toEqual([
    { t: 'tool', name: 'Reading package.json:1', status: 'start' },
    { t: 'tool', name: 'Reading package.json:1', status: 'ok' },
  ])
  // the streamed chunks and the final agree, which is the invariant worth pinning: kiro sends the
  // answer as agent_message_chunks and then repeats it whole in runFinished
  const streamed = events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')
  expect((events.find((e) => e.t === 'done') as { final: string }).final).toBe(streamed)
  expect(streamed).toContain('1.0.0')
  expect(events.some((e) => e.t === 'usage')).toBe(true)
})

test('attach resumes the session interactively', () => {
  expect(kiroAdapter.attach(bound('sess_abc')).cmd).toEqual(['kiro-cli', 'chat', '--resume-id', 'sess_abc'])
})

// A failed run with no stopReason must not invent "run failed" - an empty message lets turn.ts
// fall through to stderr, which is where kiro puts the reason when the stream has none.
test('a failed run without a stop reason reports an empty message, not a placeholder', () => {
  const line = JSON.stringify({ type: 'runFinished', data: { sessionId: 's', status: 'failed' } })
  expect(kiroAdapter.parse(line)).toEqual([{ t: 'session', foreignId: 's' }, { t: 'error', message: '', kind: 'unknown' }])
})

// kiro streams the answer in chunks and then repeats it in runFinished.finalText - with a
// finalTextTruncated flag, which means it truncates. The streamed text konvoy already holds in
// full must win whenever finalText is missing or flagged; only an untruncated finalText is
// authoritative.
test('a truncated or absent finalText yields no done event, so the streamed answer stands', () => {
  const truncated = JSON.stringify({ type: 'runFinished', data: { sessionId: 's', status: 'success', finalText: 'long a', finalTextTruncated: true } })
  expect(kiroAdapter.parse(truncated).filter((e) => e.t === 'done')).toEqual([])
  const absent = JSON.stringify({ type: 'runFinished', data: { sessionId: 's', status: 'success' } })
  expect(kiroAdapter.parse(absent).filter((e) => e.t === 'done')).toEqual([])
  const whole = JSON.stringify({ type: 'runFinished', data: { sessionId: 's', status: 'success', finalText: 'long answer', finalTextTruncated: false } })
  expect(kiroAdapter.parse(whole).filter((e) => e.t === 'done')).toEqual([{ t: 'done', final: 'long answer' }])
})

// Probed against kiro-cli 2.23.0 on 2026-09-22, offline: `--agent <AGENT>` takes a NAME, and a
// name resolves only from `<cwd>/.kiro/agents` (workspace) or `$KIRO_HOME/agents` (global), per
// `kiro-cli agent list`. A path passed to --agent is not loaded. KIRO_HOME cannot be moved -
// kiro's conversation store lives under it, so relocating it orphans every binding and breaks
// `attach --id` - which leaves a project-local profile as the only place konvoy may write one.
// `kiro-cli agent validate --path` accepts exactly this shape.
test('a minimal kiro turn writes a project agent profile and runs under it', async () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/konvoy-kiro-${Bun.nanoseconds()}`
  const ctxMinimal = ctx({ cwd: dir, harness: 'minimal' })
  await kiroAdapter.prepare?.(ctxMinimal)

  const profile = await Bun.file(`${dir}/.kiro/agents/konvoy-minimal.json`).json()
  expect(profile.name).toBe('konvoy-minimal')
  // what "minimal" has to mean for kiro: no MCP servers of its own, none merged from the user's
  // mcp.json, and no resources - kiro_default pulls in AGENTS.md, README.md, every skill glob
  // and the global steering directory through exactly these three fields
  expect(profile.mcpServers).toEqual({})
  expect(profile.includeMcpJson).toBe(false)
  expect(profile.resources).toEqual([])

  const cmd = kiroAdapter.turn(ctxMinimal).cmd
  const at = cmd.indexOf('--agent')
  expect(at).toBeGreaterThan(-1)
  expect(cmd[at + 1]).toBe('konvoy-minimal')
  await Bun.$`rm -rf ${dir}`.quiet().nothrow()
})

test('an inherited kiro turn writes nothing and names no agent, so the user own setup loads', async () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/konvoy-kiro-inherit-${Bun.nanoseconds()}`
  const inherited = ctx({ cwd: dir, harness: 'inherit' })
  await kiroAdapter.prepare?.(inherited)
  expect(await Bun.file(`${dir}/.kiro/agents/konvoy-minimal.json`).exists()).toBe(false)
  expect(kiroAdapter.turn(inherited).cmd).not.toContain('--agent')
  await Bun.$`rm -rf ${dir}`.quiet().nothrow()
})

// kiro does NOT fail when --agent cannot be resolved: measured 2026-09-22, it prints
// `[warn] failed to set agent '<name>': Internal error` on stderr and carries on with the
// default agent. konvoy would then report a minimal harness while running the user's full
// setup, which is the exact class of defect design section 18 had to be corrected for.
test('a kiro warning that the agent did not load is surfaced, not swallowed', () => {
  const warnings = kiroAdapter.warnings?.("[warn] failed to set agent 'konvoy-minimal': Internal error") ?? []
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('konvoy-minimal')
  expect(warnings[0]).toContain('not the minimal harness')
  // an ordinary turn says nothing
  expect(kiroAdapter.warnings?.('')).toEqual([])
  expect(kiroAdapter.warnings?.('some unrelated stderr chatter')).toEqual([])
})
