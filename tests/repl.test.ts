import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { createSession, getSessionBySlug, recordTurn, renameSession } from '../src/store/queries'
import { runRepl, replHelp, type ReplIo } from '../src/commands/repl'
import type { Session } from '../src/types'

async function* lines(...xs: string[]): AsyncGenerator<string> {
  for (const x of xs) yield x
}

function harness(input: string[], tty = true) {
  const db = openDb(':memory:')
  const cfg = configSchema.parse({})
  const s = createSession(db, { slug: 's', goal: '', cwd: '/nowhere/s', lead: 'claude' })
  const out: string[] = []
  const calls: string[][] = []
  const io: ReplIo = { lines: lines(...input), write: (t) => out.push(t), tty }
  const run = (tokens: string[], slug: string) => {
    calls.push([slug, ...tokens])
    return 0
  }
  return { db, cfg, s, out, calls, io, run, go: (session: Session = s) => runRepl(io, db, cfg, '/nowhere/s', session, run) }
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
