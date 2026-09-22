import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { createSession, getSessionBySlug, recordTurn, renameSession } from '../src/store/queries'
import { runRepl, replHelp, messageSplitter, terminalIo, PASTE_ON, PASTE_OFF, type ReplIo, type InputStream } from '../src/commands/repl'
import type { Session } from '../src/types'

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
  expect(h.calls).toEqual([['s', 'send', 'claude', 'hello'], ['s', 'send', 'codex', 'review it']])
  expect(h.out.filter((t) => t.endsWith('> '))).toEqual(['s claude> ', 's claude> ', 's codex> ', 's codex> '])
})

test('after a turn the prompt follows the agent that actually answered', async () => {
  const h = harness(['hello', 'again'])
  h.run = (tokens, slug) => {
    h.calls.push([slug, ...tokens])
    recordTurn(h.db, { sessionId: h.s.id, agent: 'kiro', prompt: tokens[2]!, final: 'f', exitCode: 0, costUsd: 0 })
    return 0
  }
  await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
  expect(h.calls[1]).toEqual(['s', 'send', 'kiro', 'again'])
})

test('/use rejects an unknown or disabled agent and keeps the current one', async () => {
  const h = harness(['/use bogus', '/use codex', 'x'])
  h.cfg = configSchema.parse({ agents: { codex: { enabled: false } } })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await runRepl(h.io, h.db, h.cfg, '/nowhere/s', h.s, h.run)
    expect(h.calls).toEqual([['s', 'send', 'claude', 'x']])
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
      'unknown agent "bogus" - expected one of claude, codex, kiro, opencode',
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
  expect(h.calls[1]).toEqual(['fresh-name', 'send', 'claude', 'x'])
  expect(h.out.at(-2)).toBe('fresh-name claude> ')
})

test('/goal stores the goal without leaving the loop', async () => {
  const h = harness(['/goal ship it', 'x'])
  await h.go()
  expect(getSessionBySlug(h.db, 's')?.goal).toBe('ship it')
  expect(h.calls).toEqual([['s', 'send', 'claude', 'x']])
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
  const help = h.out.find((t) => t.includes('/use <agent>'))!
  expect(help).toContain('/send <agent> "<msg>"')
  expect(replHelp()).toBe(help)
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
  expect(h.calls).toEqual([['s', 'send', 'claude', 'hello']])
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

  expect(calls).toEqual([['send', 'claude', 'fix the refresh\nand the retry\nand the test']])
})
