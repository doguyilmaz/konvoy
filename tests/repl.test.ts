import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { agentIds } from '../src/config/schema'
import { createSession, getSessionBySlug, recordTurn, renameSession } from '../src/store/queries'
import { runRepl, replHelp, messageSplitter, terminalIo, PASTE_ON, PASTE_OFF, type ReplIo, type ReplOptions, type InputStream, type RunExtras } from '../src/commands/repl'
import type { EditorIo, PickSpec, PromptSpec } from '../src/editor'
import type { Config } from '../src/config/schema'
import type { Session } from '../src/types'
import { commandHelp } from '../src/commands/table'

const START = '\x1b[200~'
const END = '\x1b[201~'

function fakeStream(isTTY = true) {
  const handlers: { data: ((c: Uint8Array) => void)[]; end: ((c: Uint8Array) => void)[] } = { data: [], end: [] }
  const encoder = new TextEncoder()
  const events: string[] = []
  const stream: InputStream = {
    on: (event, handler) => handlers[event].push(handler),
    pause: () => events.push('pause'),
    resume: () => events.push('resume'),
    isTTY,
  }
  return {
    stream,
    events,
    send: (text: string) => handlers.data.forEach((h) => h(encoder.encode(text))),
    finish: () => handlers.end.forEach((h) => h(new Uint8Array())),
  }
}

async function* lines(...xs: string[]): AsyncGenerator<string> {
  for (const x of xs) yield x
}

function harness(input: string[], tty = true) {
  const db = openDb(':memory:')
  const cfg = configSchema.parse({})
  const s = createSession(db, { slug: 's', goal: '', cwd: '/nowhere/s', lead: 'claude' })
  const out: string[] = []
  const calls: string[][] = []
  const events: string[] = []
  const io: ReplIo = {
    lines: lines(...input),
    write: (t) => out.push(t),
    tty,
    pause: () => events.push('pause'),
    resume: () => events.push('resume'),
  }
  const run = (tokens: string[], slug: string) => {
    calls.push([slug, ...tokens])
    events.push(tokens[0]!)
    return 0
  }
  return { db, cfg, s, out, calls, events, io, run, go: (session: Session = s) => runRepl(io, db, cfg, '/nowhere/s', session, run) }
}

test('plain text is a turn against the current agent, and /use changes the agent', async () => {
  const h = harness(['hello', '/use codex', 'review it'])
  expect(await h.go()).toBe(0)
  expect(h.calls).toEqual([['s', 'send', 'claude', '--', 'hello'], ['s', 'send', 'codex', '--', 'review it']])
  expect(h.out.filter((t) => t.endsWith('\u203a '))).toEqual(['claude \u203a ', 'claude \u203a ', 'codex \u203a ', 'codex \u203a '])
})

test('after a turn the prompt follows the agent that actually answered', async () => {
  const h = harness(['hello', 'again'])
  h.run = (tokens, slug) => {
    h.calls.push([slug, ...tokens])
    recordTurn(h.db, { sessionId: h.s.id, agent: 'kiro', prompt: tokens[3]!, final: 'f', exitCode: 0, costUsd: 0 })
    return 0
  }
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  expect(h.calls[1]).toEqual(['s', 'send', 'kiro', '--', 'again'])
})

test('/use rejects an unknown or disabled agent and keeps the current one', async () => {
  const h = harness(['/use bogus', '/use codex', 'x'])
  h.cfg = configSchema.parse({ agents: { codex: { enabled: false } } })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
    expect(h.calls).toEqual([['s', 'send', 'claude', '--', 'x']])
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
      `unknown agent "bogus" - expected one of ${agentIds.join(', ')}`,
      'codex is disabled in this konvoy config',
    ])
  } finally {
    err.mockRestore()
  }
})

test('/rename implies the current session and the prompt picks up the new name', async () => {
  const h = harness(['/rename Fresh Name', 'x'])
  h.run = (tokens, slug) => {
    h.calls.push([slug, ...tokens])
    if (tokens[0] === 'rename') renameSession(h.db, h.s.id, 'fresh-name')
    return 0
  }
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  expect(h.calls[0]).toEqual(['s', 'rename', 's', 'Fresh Name'])
  expect(h.calls[1]).toEqual(['fresh-name', 'send', 'claude', '--', 'x'])
  // the slug lives in the banner and in /roster, so a rename does not change the prompt
  expect(h.out.at(-2)).toBe('claude \u203a ')
})

test('/goal stores the goal without leaving the loop', async () => {
  const h = harness(['/goal ship it', 'x'])
  await h.go()
  expect(getSessionBySlug(h.db, 's')?.goal).toBe('ship it')
  expect(h.calls).toEqual([['s', 'send', 'claude', '--', 'x']])
})

test('/quit leaves before the remaining input is read, and /help lists the commands', async () => {
  let drained = false
  async function* input(): AsyncGenerator<string> {
    yield '/help'
    yield '/quit'
    drained = true
    yield 'never sent'
  }
  const h = harness([])
  h.io.lines = input()
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  expect(drained).toBe(false)
  expect(h.calls).toEqual([])
  const help = h.out.find((t) => t.includes('/use [agent|konvoy]'))!
  expect(help).toContain('/send <agent> "<msg>"')
  expect(replHelp()).toBe(help)
})

test('/help <command> shows that command, with the REPL\'s own spelling', async () => {
  const h = harness(['/help install', '/help /log'])
  await h.go()
  expect(h.out).toContain(commandHelp('install', '/')!)
  expect(h.out.find((t) => t.startsWith('usage: /log'))).toContain('also: /history')
  expect(h.calls).toEqual([])
})

test('any other slash command goes through the table with the session implied', async () => {
  const h = harness(['/usage --all --chart', '/attach', '/attach codex --id abc'])
  await h.go()
  expect(h.calls).toEqual([
    ['s', 'usage', '--all', '--chart'],
    ['s', 'attach', 'claude'],
    ['s', 'attach', 'codex', '--id', 'abc'],
  ])
})

test('without a tty nothing is prompted and EOF ends the loop', async () => {
  const h = harness(['hello'], false)
  expect(await h.go()).toBe(0)
  expect(h.out).toEqual([])
  expect(h.calls).toEqual([['s', 'send', 'claude', '--', 'hello']])
})

test('stdin is paused for the whole run of every command, so an attached TUI owns the keyboard', async () => {
  const h = harness(['hello', '/attach', '/roster'])
  await h.go()
  expect(h.events).toEqual(['pause', 'send', 'resume', 'pause', 'attach', 'resume', 'pause', 'roster', 'resume'])
})

// Pasting three lines into the REPL sent three turns: the tty hands a paste over as lines, and
// every line was a message. The agent answered the first fragment while the rest queued behind
// it, which is not what anyone pasting a stack trace or a three-line instruction meant.
test('a pasted block is one message, not one message per line', () => {
  const split = messageSplitter()
  expect(split.push(`${START}first line\nsecond line\nthird line${END}\n`)).toEqual([
    'first line\nsecond line\nthird line',
  ])
  expect(split.end()).toEqual([])
})

test('typed lines are still one message each, paste mode or not', () => {
  const split = messageSplitter()
  expect(split.push('one\ntwo\n')).toEqual(['one', 'two'])
  expect(split.push('half')).toEqual([])
  expect(split.push(' a line\n')).toEqual(['half a line'])
  expect(split.end()).toEqual([])
})

test('a paste split across reads survives, markers cut in half included', () => {
  const split = messageSplitter()
  expect(split.push(`${START}alpha\nbe`)).toEqual([])
  expect(split.push('ta\ngamma\x1b')).toEqual([])
  expect(split.push('[201~\n')).toEqual(['alpha\nbeta\ngamma'])
})

test('what was typed before a paste belongs to the same message', () => {
  const split = messageSplitter()
  expect(split.push(`fix this: ${START}line one\nline two${END}\n`)).toEqual(['fix this: line one\nline two'])
})

test('a paste that carries carriage returns arrives with plain newlines', () => {
  const split = messageSplitter()
  expect(split.push(`${START}one\r\ntwo\rthree${END}\n`)).toEqual(['one\ntwo\nthree'])
})

test('end of input flushes an unterminated paste instead of eating it', () => {
  const split = messageSplitter()
  expect(split.push(`${START}half a paste`)).toEqual([])
  expect(split.end()).toEqual(['half a paste'])
})

test('terminalIo turns bracketed paste on for a terminal and off when it closes', () => {
  const written: string[] = []
  const fake = fakeStream(true)
  const io = terminalIo(fake.stream, (t) => written.push(t))
  expect(written).toEqual([PASTE_ON])
  io.close?.()
  expect(written).toEqual([PASTE_ON, PASTE_OFF])
})

test('a pipe is left alone: no escape sequence is written to something that cannot paste', () => {
  const written: string[] = []
  const fake = fakeStream(false)
  const io = terminalIo(fake.stream, (t) => written.push(t))
  expect(written).toEqual([])
  io.close?.()
  expect(written).toEqual([])
  expect(io.tty).toBe(false)
})

// The one test that would have failed before the fix for the reason a user would report it:
// three pasted lines, one turn, the whole block as the prompt.
test('the REPL sends one turn for a pasted block, with every line of it', async () => {
  const db = openDb(':memory:')
  const cfg = configSchema.parse({})
  const s = createSession(db, { slug: 's', goal: '', cwd: '/nowhere/s', lead: 'claude' })
  const fake = fakeStream(true)
  const io = terminalIo(fake.stream, () => {})
  const calls: string[][] = []

  fake.send(`${START}fix the refresh\nand the retry\nand the test${END}\n`)
  fake.finish()
  await runRepl(io, db, cfg, '/nowhere/s', s, (tokens) => {
    calls.push(tokens)
    return 0
  })

  expect(calls).toEqual([['send', 'claude', '--', 'fix the refresh\nand the retry\nand the test']])
})

// /help was two blocks padded to two different widths, and the inner list was produced by
// post-processing the CLI listing with replaceAll('  konvoy ', '  /'), which also rewrote the
// word "konvoy" inside a summary: the version row read "/and agent versions" to a real user.
test('/help is one list on one column, and no summary is mangled', () => {
  // the commands, then a blank line, then the keys and prefixes
  const [commands, keys] = replHelp().trimEnd().split('\n\n')
  const lines = commands!.split('\n')
  expect(lines.length).toBeGreaterThan(15)
  expect(keys).toContain('@agent <msg>')
  expect(keys).toContain('esc')

  const starts = new Set<number>()
  for (const line of lines) {
    const row = /^ {2}(\/\S+(?: \S+)*?) {2,}(\S.*)$/.exec(line)
    expect(row, line).not.toBeNull()
    starts.add(line.indexOf(row![2]!))
  }
  // every summary begins at the same column, which is what makes a list readable
  expect(starts.size).toBe(1)

  expect(replHelp()).toContain('konvoy and agent versions')
  expect(replHelp()).not.toContain('/and agent versions')
})

test('the prompt is coloured on a terminal that takes colour, and plain text everywhere else', async () => {
  const h = harness(['x'])
  h.io.color = true
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  const prompts = h.out.filter((t) => t.includes('claude'))
  expect(prompts.length).toBeGreaterThan(0)
  for (const line of prompts) {
    expect(line).toContain('\x1b[')
    expect(line).toContain('claude')
    expect(line).toContain('\u203a')
  }

  const plain = harness(['x'])
  await runRepl(plain.io, plain.db, plain.cfg, '/nowhere/s', plain.s, plain.run)
  expect(plain.out.filter((t) => t.endsWith('\u203a '))).toEqual(['claude \u203a ', 'claude \u203a '])
})

test('the status line appears once a turn has been recorded, and not again until it changes', async () => {
  const h = harness(['hello', '/help', 'again'])
  h.io.tty = true
  let turns = 0
  h.run = (tokens, slug) => {
    h.calls.push([slug, ...tokens])
    if (tokens[0] === 'send') {
      turns++
      recordTurn(h.db, {
        sessionId: h.s.id, agent: 'claude', prompt: 'p', final: 'f', exitCode: 0,
        costUsd: 0.01 * turns, inputTokens: 1000 * turns, outputTokens: 10,
      })
    }
    return 0
  }
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)

  const status = h.out.filter((t) => t.startsWith('  s · '))
  // one after the first turn, one after the second - /help in between changed nothing, so it
  // printed nothing
  expect(status).toHaveLength(2)
  expect(status[0]).toContain('1 turn ·')
  expect(status[1]).toContain('2 turns ·')
  expect(status[1]).toContain('$0.03')
})

// The REPL's own words beyond the table. Each keeps the conversation where it is unless it says
// otherwise: a mention asks once, a retry repeats, a model or effort change lasts until you leave.
test('@agent asks another agent once and the prompt stays with the current one', async () => {
  const h = harness(['@codex review the diff', 'next', '@kiro'])
  await h.go()
  expect(h.calls).toEqual([['s', 'send', 'codex', '--', 'review the diff'], ['s', 'send', 'claude', '--', 'next']])
  // a bare mention switches, like /use
  expect(h.out.at(-2)).toBe('kiro \u203a ')
})

test('/model and /effort change the current agent for this REPL, and only this one', async () => {
  const seen: (string | undefined)[][] = []
  const h = harness(['/model opus', '/effort low', 'go', '/use codex', 'then', '/model default', '/model -dangerous'])
  h.run = (tokens: string[], slug: string, extras?: RunExtras) => {
    h.calls.push([slug, ...tokens])
    const c = extras?.cfg?.agents
    seen.push([tokens[1], c?.claude?.model, c?.claude?.effort, c?.codex?.model])
    return 0
  }
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
    expect(seen).toEqual([
      ['claude', 'opus', 'low', undefined],
      ['codex', 'opus', 'low', undefined],
    ])
    // a model string that would read as a flag on a command line is refused
    expect(err.mock.calls.some((c) => String(c[0]).includes('-dangerous'))).toBe(true)
  } finally {
    err.mockRestore()
  }
})

test('/retry sends the last prompt again, to the current agent or the one named', async () => {
  const h = harness(['/retry', 'first try', '/retry', '/retry codex'])
  h.run = (tokens, slug) => {
    h.calls.push([slug, ...tokens])
    if (tokens[0] === 'send') recordTurn(h.db, { sessionId: h.s.id, agent: tokens[1] as 'claude', prompt: tokens[3]!, final: 'f', exitCode: 0, costUsd: 0 })
    return 0
  }
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  } finally {
    err.mockRestore()
  }
  expect(h.calls).toEqual([
    ['s', 'send', 'claude', '--', 'first try'],
    ['s', 'send', 'claude', '--', 'first try'],
    ['s', 'send', 'codex', '--', 'first try'],
  ])
})

test('a reopened session picks the conversation up with the agent it was last talking to', async () => {
  const h = harness(['hi'])
  recordTurn(h.db, { sessionId: h.s.id, agent: 'opencode', prompt: 'p', final: 'f', exitCode: 0, costUsd: 0 })
  await h.go()
  expect(h.calls).toEqual([['s', 'send', 'opencode', '--', 'hi']])
})

test('!command runs in the session directory with the terminal handed over, and is not a turn', async () => {
  const dir = `/tmp/konvoy-test-shell-${Bun.nanoseconds()}`
  await Bun.write(`${dir}/marker`, '')
  const db = openDb(':memory:')
  const cfg = configSchema.parse({})
  const s = createSession(db, { slug: 's', goal: '', cwd: dir, lead: 'claude' })
  const events: string[] = []
  const io: ReplIo = {
    lines: lines('!touch shelled'),
    write: () => {},
    tty: false,
    pause: () => events.push('pause'),
    resume: () => events.push('resume'),
  }
  const calls: string[][] = []
  await runRepl(io, db, cfg, dir, s, (tokens) => (calls.push(tokens), 0))
  expect(await Bun.file(`${dir}/shelled`).exists()).toBe(true)
  expect(calls).toEqual([])
  expect(events).toEqual(['pause', 'resume'])
})

// After a delegation the newest turn is the recipient's, and its prompt is the task konvoy wrote
// for it. What the person asked last is the latest turn with no parent.
test('/retry repeats what the person asked, not the task a handoff wrote', async () => {
  const h = harness(['/retry'])
  const asked = recordTurn(h.db, { sessionId: h.s.id, agent: 'claude', prompt: 'fix the login bug', final: 'f', exitCode: 0, costUsd: 0 })
  recordTurn(h.db, { sessionId: h.s.id, agent: 'codex', prompt: 'run the test suite', final: 'f', exitCode: 0, costUsd: 0, parentTurnId: asked })
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  expect(h.calls).toEqual([['s', 'send', 'codex', '--', 'fix the login bug']])
})

// ---- lists to pick from: `/model` opened nothing and accepted any string, which the turn then
// failed on ("Invalid model reference: opus-5-5")

const catalog = { complete: true, source: 'opencode models', models: [{ id: 'opencode/claude-opus-5-5' }, { id: 'opencode/claude-sonnet-5' }] }

function picking(input: string[], answers: (string | null)[]) {
  const h = harness(input)
  const shown: PickSpec[] = []
  const seen: (Config | undefined)[] = []
  const hooks: { turn?: (tokens: string[]) => void } = {}
  h.io.pick = async (spec) => {
    shown.push(spec)
    return answers.shift() ?? null
  }
  const run = (tokens: string[], slug: string, extras?: RunExtras): number => {
    h.calls.push([slug, ...tokens])
    seen.push(extras?.cfg)
    hooks.turn?.(tokens)
    return 0
  }
  const go = (options: ReplOptions = {}) =>
    runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, run, { models: async () => catalog, efforts: async () => undefined, ...options })
  return { ...h, shown, seen, hooks, go }
}

test('/model alone opens the list of models the agent offers, and the one chosen is used', async () => {
  const h = picking(['/use opencode', '/model', 'hi'], ['opencode/claude-sonnet-5'])
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await h.go()
    expect(h.shown[0]!.title).toBe('Model for opencode')
    expect(h.shown[0]!.items.map((i) => i.value)).toEqual(['default', 'opencode/claude-opus-5-5', 'opencode/claude-sonnet-5'])
    expect(h.calls).toEqual([['s', 'send', 'opencode', '--', 'hi']])
    expect(h.seen[0]?.agents.opencode?.model).toBe('opencode/claude-sonnet-5')
  } finally {
    err.mockRestore()
  }
})

test('a typed model the agent does not offer is refused, with the one it was probably meant to be', async () => {
  const h = picking(['/use opencode', '/model opus-5-5', 'hi'], [])
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await h.go()
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('"opus-5-5" is not a model opencode offers - did you mean opencode/claude-opus-5-5? /model lists them')
    expect(h.seen[0]).toBeUndefined()
  } finally {
    err.mockRestore()
  }
})

test('/effort and /permission alone open their lists, and a closed list changes nothing', async () => {
  const h = picking(['/effort', '/permission', '/permission', 'hi'], ['low', null, 'yolo'])
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await h.go()
    expect(h.shown.map((s) => s.title)).toEqual(['Effort for claude', 'Permission for claude', 'Permission for claude'])
    expect(h.shown[1]!.items.find((i) => i.current)?.value).toBe('edit')
    expect(h.seen[0]?.agents.claude).toEqual({ effort: 'low', permission: 'yolo' })
  } finally {
    err.mockRestore()
  }
})

test('/use alone lists konvoy mode and the agents; konvoy mode routes through the ready ones', async () => {
  const h = picking(['/use', 'hi', 'again'], ['konvoy'])
  // claude was out of quota, and the chain handed the first turn to codex
  h.hooks.turn = (tokens) => {
    if (tokens[3] === 'hi') recordTurn(h.db, { sessionId: h.s.id, agent: 'codex', prompt: 'hi', final: 'done', exitCode: 0, costUsd: 0 })
  }
  await h.go({ installed: new Set(['claude', 'codex', 'opencode']) })
  expect(h.shown[0]!.items[0]).toMatchObject({ value: 'konvoy' })
  expect(h.seen[0]?.failover.chain).toEqual(['claude', 'codex', 'opencode'])
  // the next prompt starts from the agent that answered, and claude, having run out, waits its turn
  expect(h.calls[1]).toEqual(['s', 'send', 'codex', '--', 'again'])
  expect(h.seen[1]?.failover.chain).toEqual(['codex', 'claude', 'opencode'])
  // an agent not installed is never in the route; the prompt says konvoy is listening
  expect(h.seen[0]?.failover.chain).not.toContain('kiro')
  expect(h.out.filter((t) => t.endsWith('› ')).at(-1)).toBe('konvoy › ')
})

test('an @agent question in konvoy mode goes to that agent alone', async () => {
  const h = picking(['/use konvoy', '@codex look'], [])
  await h.go({ installed: new Set(['claude', 'codex']) })
  expect(h.calls).toEqual([['s', 'send', 'codex', '--', 'look']])
  expect(h.seen[0]).toBeUndefined()
})

test('/resume alone lists the sessions; the current one is ticked and choosing it says so', async () => {
  const h = picking(['/resume', '/resume'], ['s', 'other'])
  createSession(h.db, { slug: 'other', goal: 'elsewhere', cwd: '/nowhere/o', lead: 'kiro' })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await h.go()
    expect(h.shown[0]!.items.map((i) => [i.value, i.current])).toEqual([
      ['other', false],
      ['s', true],
    ])
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('already in s')
    expect(h.calls).toEqual([['s', 'resume', 'other']])
  } finally {
    err.mockRestore()
  }
})

test('/config set alone walks key, value and file; a global-only key goes to the global file', async () => {
  const h = picking(['/config set', '/config set defaults.effort'], ['defaults.permission', 'auto', 'low', 'project'])
  let reloads = 0
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await h.go({ loadConfig: async () => (reloads++, h.cfg) })
    expect(h.calls).toEqual([
      ['s', 'config', 'set', 'defaults.permission', 'auto', '--global'],
      ['s', 'config', 'set', 'defaults.effort', 'low'],
    ])
    // the REPL runs on what the files say after each write
    expect(reloads).toBe(2)
  } finally {
    err.mockRestore()
  }
})

test('with no terminal to point at, a list is printed with nothing chosen', async () => {
  const h = harness(['/permission'], false)
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  const out = h.out.join('')
  expect(out).toContain('Permission for claude')
  expect(out).toContain('edit ✔')
  expect(h.calls).toEqual([])
})

// The footer says who is listening, bottom right like the agents' own CLIs, and makes the shared
// context visible: an agent that has missed turns says how many it will be caught up on.
test('the footer names who is listening and how far behind it is; shift+tab reaches konvoy mode', async () => {
  const h = harness([])
  const footers: string[][] = []
  const script = ['@codex first', '/help', 'CYCLE', 'CYCLE', 'second', null]
  let cycle: (() => void) | undefined
  const editor = {
    read: async (spec: () => PromptSpec) => {
      let next = script.shift()
      while (next === 'CYCLE') {
        cycle?.()
        next = script.shift()
      }
      footers.push(spec().footer)
      return next ?? null
    },
    pick: async () => null,
    busy: async <T,>(fn: (signal: AbortSignal) => Promise<T>) => fn(new AbortController().signal),
    suspend: async <T,>(fn: () => Promise<T>) => fn(),
    clearScreen: () => {},
    close: () => {},
    set onCycle(fn: (() => void) | undefined) {
      cycle = fn
    },
  }
  h.io.editor = editor as unknown as EditorIo
  h.io.columns = () => 160
  h.run = (tokens, slug) => {
    h.calls.push([slug, ...tokens])
    recordTurn(h.db, { sessionId: h.s.id, agent: 'codex', prompt: tokens[3]!, final: 'ok', exitCode: 0, costUsd: 0 })
    return 0
  }
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run, { installed: new Set(['claude', 'codex']) })
  const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '')
  // before anything: claude listening, nothing to catch up on, the switch key at hand
  expect(plain(footers[0]![1]!)).toContain('● claude · high · edit')
  expect(plain(footers[0]![1]!)).toContain('⇧⇥ switch')
  expect(plain(footers[0]![0]!)).not.toContain('behind')
  // codex answered an @codex question claude never saw: claude will be caught up on it
  expect(plain(footers[1]![0]!)).toContain('claude is 1 turn behind')
  // shift+tab twice: to codex, then konvoy mode, which shows the route it will take
  expect(plain(footers[2]![1]!)).toContain('✻ konvoy → codex › claude')
})
