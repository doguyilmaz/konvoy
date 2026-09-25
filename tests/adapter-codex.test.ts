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

// `codex exec resume` is its own subcommand with its own flag set: --json, -s, -m and the rest
// belong to `exec` and must precede it. The version of this test that stood before pinned
// `codex exec resume <id> --json …`, which codex rejects with "unexpected argument" - every
// resumed codex turn had failed live while the suite was green.
test('a later turn resumes the thread by id, with resume after every exec-level flag', () => {
  const cmd = codexAdapter.turn(ctx({ binding: bound('thread-9') })).cmd
  expect(cmd.slice(0, 2)).toEqual(['codex', 'exec'])
  expect(cmd).toContain('--json')
  const at = cmd.indexOf('resume')
  expect(cmd.slice(at, at + 3)).toEqual(['resume', 'thread-9', '--'])
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
    { t: 'error', message: 'Skill descriptions were shortened', kind: 'unknown', source: 'item' },
  ])
})

test('other completed items are reported as tool activity', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: ['ls'] } })
  expect(codexAdapter.parse(line)).toEqual([{ t: 'tool', name: 'Shell', status: 'ok' }])
})

test('turn.completed yields usage', () => {
  const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 18173, output_tokens: 5 } })
  expect(codexAdapter.parse(line)).toEqual([{ t: 'usage', inputTokens: 18173, outputTokens: 5 }])
})

test('the captured fixture parses into session, tool call, text, notice and usage', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/codex.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => codexAdapter.parse(l))
  expect(events.find((e) => e.t === 'session')).toEqual({ t: 'session', foreignId: '01a0cf74-74bd-7ff0-8fd8-98fc83ffc127' })
  // the capture holds the started/completed pair for one shell call, and both carry the command:
  // the started item is what opens the live line, the completed one settles it with its exit code
  expect(events.filter((e) => e.t === 'tool')).toEqual([
    { t: 'tool', name: 'Shell', status: 'start', detail: 'cat package.json' },
    { t: 'tool', name: 'Shell', status: 'ok', detail: 'cat package.json' },
  ])
  const text = events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')
  expect(text).toContain('package.json')
  expect(text.trim().endsWith('1.0.0')).toBe(true)
  // This capture carries no skills-budget notice, because `--ignore-user-config` leaves codex with
  // no skills to shorten; the notice-on-a-healthy-turn path lives in codex-rate.jsonl, where the
  // item error must stay unclassified so turn.ts can clear it rather than trip failover.
  expect(events.some((e) => e.t === 'usage')).toBe(true)
})

test('attach resumes the thread interactively', () => {
  expect(codexAdapter.attach(bound('thread-9')).cmd).toEqual(['codex', 'resume', 'thread-9'])
})

// An error event with no words must say nothing rather than invent "unknown error" or
// "turn failed": turn.ts reads stderr only when the stream's error is empty, so a placeholder
// hides the CLI's real reason (see the claude dead-session case in tests/session.test.ts).
test('an error item or a failed turn without a message reports an empty message, not a placeholder', () => {
  expect(codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: { type: 'error' } }))).toEqual([{ t: 'error', message: '', kind: 'unknown', source: 'item' }])
  expect(codexAdapter.parse(JSON.stringify({ type: 'turn.failed', error: {} }))).toEqual([{ t: 'error', message: '', kind: 'unknown', source: 'turn' }])
})

// Whether a real codex rate limit arrives as an item-level error or as turn.failed decides how
// the two must be told apart; no capture shows it yet. The parsed event now carries which wire
// event it came from, and konvoy persists every event - so the next real limit answers it from
// the event log, with nothing asked of the user.
test('an error event says whether it came from an item or from turn.failed', () => {
  expect(codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'notice' } }))[0]).toMatchObject({ t: 'error', source: 'item' })
  expect(codexAdapter.parse(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }))[0]).toMatchObject({ t: 'error', source: 'turn' })
})

// From the real capture: an item.started/item.completed pair for a command_execution carries the
// command itself. konvoy rendered the item TYPE and dropped the command, so a codex turn showed
// "command_execution" four times over and said nothing about what it ran.
test('a codex shell item carries the command it ran', () => {
  const started = codexAdapter.parse(
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_2', type: 'command_execution', command: "/bin/zsh -lc 'cat package.json'", status: 'in_progress' },
    }),
  )
  // the login-shell wrapper is codex's plumbing; the command inside it is what the agent ran
  expect(started).toEqual([{ t: 'tool', name: 'Shell', status: 'start', detail: 'cat package.json' }])

  const completed = codexAdapter.parse(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'command_execution', command: 'bun test', exit_code: 1, status: 'completed' },
    }),
  )
  expect(completed).toEqual([{ t: 'tool', name: 'Shell', status: 'error', detail: 'bun test' }])
})

// codex's own item types are plumbing. What a reader recognises is what every other CLI calls the
// same act, and the subject each item carries under its own key: the files, the server, the query.
test('codex items are named for what they do, with the subject each carries', () => {
  const edit = codexAdapter.parse(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', status: 'completed', changes: [{ path: 'src/auth.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
    }),
  )
  expect(edit).toEqual([{ t: 'tool', name: 'Edit', status: 'ok', detail: 'src/auth.ts +1 more' }])

  const mcp = codexAdapter.parse(
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'github', tool: 'create_issue', status: 'failed' } }),
  )
  expect(mcp).toEqual([{ t: 'tool', name: 'github.create_issue', status: 'error' }])

  const search = codexAdapter.parse(JSON.stringify({ type: 'item.started', item: { type: 'web_search', query: 'bun sqlite wal' } }))
  expect(search).toEqual([{ t: 'tool', name: 'WebSearch', status: 'start', detail: 'bun sqlite wal' }])

  // a wrapper whose command itself holds a quote is left alone rather than unwrapped wrongly
  const quoted = codexAdapter.parse(
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: "bash -lc 'echo '\\''x'\\'''" } }),
  )
  expect((quoted[0] as { detail: string }).detail).toStartWith('bash -lc')
})

// Captured on 2026-09-23 from a real exhausted codex account (design section 33 called this
// "cannot be forced" - it happened during a smoke run and cost no quota to record). The stream
// answers the question the roadmap asked: an INFORMATIONAL error and a TERMINAL one are different
// lines. The skills-budget notice arrives as `item.completed` with `item.type === "error"`, while
// the failure arrives twice, first as a top-level `{"type":"error"}` and then inside `turn.failed`.
test('the captured rate-limit stream tells an informational error from a terminal one', async () => {
  const lines = (await Bun.file('tests/fixtures/streams/codex-rate.jsonl').text()).trim().split('\n')
  const events = lines.flatMap((l) => codexAdapter.parse(l))
  const errors = events.filter((e) => e.t === 'error') as { message: string; kind: string; source?: string }[]

  // the notice is an item and classifies as nothing in particular, so turn.ts can clear it
  const notice = errors.find((e) => e.source === 'item')!
  expect(notice.kind).toBe('unknown')
  expect(notice.message).toContain('skills context budget')

  // the failure is a rate limit, which is what moves a failover chain: a misread as `crash`
  // would keep the convoy on an agent that cannot work for hours
  const terminal = errors.filter((e) => e.kind === 'rate')
  expect(terminal.length).toBeGreaterThan(0)
  for (const e of terminal) expect(e.message).toContain('hit your usage limit')

  // every line that says the account is blocked is read, including the top-level one: a stream
  // that carried it without a turn.failed would otherwise be read as an ordinary crash
  expect(errors.map((e) => e.source)).toContain('stream')
  expect(errors.map((e) => e.source)).toContain('turn')
})

test('a top-level error line is read, not ignored', () => {
  const events = codexAdapter.parse(JSON.stringify({ type: 'error', message: "You've hit your usage limit." }))
  expect(events).toEqual([
    { t: 'error', message: "You've hit your usage limit.", kind: 'rate', source: 'stream' },
  ])
  // a top-level error with no words still reports, so the turn is not read as silent success
  expect(codexAdapter.parse(JSON.stringify({ type: 'error' }))).toEqual([
    { t: 'error', message: '', kind: 'unknown', source: 'stream' },
  ])
})
