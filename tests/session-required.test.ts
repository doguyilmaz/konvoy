import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { createSession } from '../src/store/queries'
import { NO_SESSION_HERE, noSessionNamed, requireNamedSession, requireSession } from '../src/commands/messages'
import { cmdRoster } from '../src/commands/roster'
import { cmdUsage } from '../src/commands/usage'
import { cmdAttach } from '../src/commands/attach'
import { cmdSend } from '../src/commands/send'
import { cmdRm } from '../src/commands/rm'
import { cmdRename } from '../src/commands/rename'
import { cmdResume } from '../src/commands/resume'

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

// rm, rename and resume take a session by name, and each wrote that sentence itself. resume also
// had a second wording of its own for the no-name case, which is the same condition the four
// commands above report with NO_SESSION_HERE.
test('every command that takes a session by name names the one it could not find', async () => {
  const db = openDb(':memory:')
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[]
  try {
    expect(cmdRm(db, '/repo', 'nope', { yes: true })).toBe(2)
    expect(await cmdRename(db, 'nope', 'other')).toBe(2)
    expect(cmdResume(db, cfg, '/repo', 'nope')).toBe(2)
    lines = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
  expect(lines).toEqual([noSessionNamed('nope'), noSessionNamed('nope'), noSessionNamed('nope')])
})

test('resume with no name gives the same answer as every other command with no session', () => {
  const db = openDb(':memory:')
  const err = spyOn(console, 'error').mockImplementation(() => {})
  let lines: string[]
  try {
    expect(cmdResume(db, cfg, '/nowhere')).toBe(2)
    lines = err.mock.calls.map((c) => String(c[0]))
  } finally {
    err.mockRestore()
  }
  expect(lines).toEqual([NO_SESSION_HERE])
})

test('requireNamedSession returns the session it found and says nothing', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'there', goal: 'g', cwd: '/repo', lead: 'claude' })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(requireNamedSession(db, 'there')?.id).toBe(s.id)
    expect(err.mock.calls.length).toBe(0)
    expect(requireNamedSession(db, 'gone')).toBe(null)
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([noSessionNamed('gone')])
  } finally {
    err.mockRestore()
  }
})
