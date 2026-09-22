import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { createSession } from '../src/store/queries'
import { NO_SESSION_HERE, noSessionNamed, requireSession } from '../src/commands/messages'
import { cmdRoster } from '../src/commands/roster'
import { cmdUsage } from '../src/commands/usage'
import { cmdAttach } from '../src/commands/attach'
import { cmdSend } from '../src/commands/send'

const cfg = configSchema.parse({})

// Four commands each carried their own copy of this sentence, so the wording drifted from what
// konvoy actually offers: it told every user to run `konvoy new "<goal>"` while bare `konvoy`
// starts a session too, and it said "here" even when the user had named a session that does not
// exist. One source, one wording, and the named case names what was looked for.
const run = async (slug?: string): Promise<string[]> => {
  const db = openDb(':memory:')
  const err = spyOn(console, 'error').mockImplementation(() => {})
  const codes: number[] = []
  try {
    codes.push(cmdRoster(db, cfg, '/nowhere', slug))
    codes.push(cmdUsage(db, cfg, '/nowhere', { all: false, ...(slug === undefined ? {} : { slug }) }))
    codes.push(await cmdAttach(db, '/nowhere', 'claude', slug === undefined ? {} : { slug }))
    codes.push(await cmdSend(db, cfg, '/nowhere', 'claude', 'hello', slug))
    expect(codes).toEqual([2, 2, 2, 2])
    return err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
}

test('every command that needs a session gives the same answer when there is none', async () => {
  const lines = await run()
  expect(lines).toEqual([NO_SESSION_HERE, NO_SESSION_HERE, NO_SESSION_HERE, NO_SESSION_HERE])
  // bare `konvoy` starts a session, so the error that tells a user how to start one must say it
  expect(NO_SESSION_HERE).toContain('`konvoy`')
})

test('a named session that is not there is named, not reported as an empty directory', async () => {
  const lines = await run('nope')
  expect(lines).toEqual([
    noSessionNamed('nope'),
    noSessionNamed('nope'),
    noSessionNamed('nope'),
    noSessionNamed('nope'),
  ])
  expect(noSessionNamed('nope')).toContain('"nope"')
})

test('requireSession returns the session it found and says nothing', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'there', goal: 'g', cwd: '/repo', lead: 'claude' })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(requireSession(db, '/repo')?.id).toBe(s.id)
    expect(requireSession(db, '/elsewhere', 'there')?.id).toBe(s.id)
    expect(err.mock.calls.length).toBe(0)
  } finally {
    err.mockRestore()
  }
})
