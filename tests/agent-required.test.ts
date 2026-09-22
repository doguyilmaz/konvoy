import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { agentIds } from '../src/adapters'
import { createSession } from '../src/store/queries'
import { requireAgent, unknownAgent } from '../src/commands/messages'
import { cmdAttach } from '../src/commands/attach'
import { cmdSend } from '../src/commands/send'
import { runRepl, type ReplIo } from '../src/commands/repl'

const cfg = configSchema.parse({})

async function* lines(...xs: string[]): AsyncGenerator<string> {
  for (const x of xs) yield x
}

// send, attach and /use each built this sentence themselves, so adding an agent or changing the
// wording meant finding three copies. They read from one place now.
test('every surface that takes an agent name rejects an unknown one the same way', async () => {
  const db = openDb(':memory:')
  createSession(db, { slug: 's', goal: 'g', cwd: '/repo', lead: 'claude' })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines_: string[]
  try {
    expect(await cmdSend(db, cfg, '/repo', 'bogus', 'hello')).toBe(2)
    expect(await cmdAttach(db, '/repo', 'bogus')).toBe(2)
    const io: ReplIo = {
      lines: lines('/use bogus'),
      write: () => {},
      tty: false,
      pause: () => {},
      resume: () => {},
    }
    await runRepl(io, db, cfg, '/repo', createSession(db, { slug: 'r', goal: '', cwd: '/repo2', lead: 'claude' }), () => 0)
    lines_ = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
  expect(lines_).toEqual([unknownAgent('bogus'), unknownAgent('bogus'), unknownAgent('bogus')])
})

test('the message names every agent konvoy actually drives', () => {
  for (const id of agentIds) expect(unknownAgent('x')).toContain(id)
  expect(unknownAgent('x')).toContain('"x"')
})

test('requireAgent hands back a known agent and says nothing about it', () => {
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(requireAgent('codex')).toBe('codex')
    expect(err.mock.calls.length).toBe(0)
    expect(requireAgent('nope')).toBe(null)
    expect(err.mock.calls.length).toBe(1)
  } finally {
    err.mockRestore()
  }
})
