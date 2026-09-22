import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { cmdNew } from '../src/commands/new'
import { cmdRename } from '../src/commands/rename'
import { acquireLock, createSession, getSessionBySlug } from '../src/store/queries'

const tmp = async () => (await Bun.$`mktemp -d`.text()).trim()
const quiet = () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const err = spyOn(console, 'error').mockImplementation(() => {})
  return { err, restore: () => { log.mockRestore(); err.mockRestore() } }
}

test('rename moves the slug, its folder and the headings inside', async () => {
  const dir = await tmp()
  const db = openDb(':memory:')
  const q = quiet()
  try {
    await cmdNew(db, configSchema.parse({}), dir, 'fix auth')
    expect(await cmdRename(db, 'fix-auth', 'Token Refresh')).toBe(0)
    expect(getSessionBySlug(db, 'fix-auth')).toBeNull()
    expect(getSessionBySlug(db, 'token-refresh')?.goal).toBe('fix auth')
    expect(await Bun.file(`${dir}/.konvoy/fix-auth/CONTEXT.md`).exists()).toBe(false)
    expect((await Bun.file(`${dir}/.konvoy/token-refresh/CONTEXT.md`).text()).split('\n')[0]).toBe('# token-refresh')
    expect((await Bun.file(`${dir}/.konvoy/token-refresh/LEDGER.md`).text()).split('\n')[0]).toBe('# Ledger - token-refresh')
  } finally {
    q.restore()
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

test('rename refuses a name another session holds and an unknown session', async () => {
  const db = openDb(':memory:')
  createSession(db, { slug: 'a', goal: 'a', cwd: '/nowhere/a', lead: 'claude' })
  createSession(db, { slug: 'b', goal: 'b', cwd: '/nowhere/b', lead: 'claude' })
  const q = quiet()
  try {
    expect(await cmdRename(db, 'a', 'b')).toBe(2)
    expect(getSessionBySlug(db, 'a')?.goal).toBe('a')
    expect(await cmdRename(db, 'nope', 'c')).toBe(2)
    expect(q.err.mock.calls.map((c) => String(c[0]))).toEqual([
      'a session named "b" already exists',
      'no konvoy session named "nope"',
    ])
  } finally {
    q.restore()
  }
})

test('rename waits for a running turn', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'busy', goal: 'g', cwd: '/nowhere/busy', lead: 'claude' })
  expect(acquireLock(db, s.id, String(process.pid))).toBe(true)
  const q = quiet()
  try {
    expect(await cmdRename(db, 'busy', 'later')).toBe(2)
    expect(getSessionBySlug(db, 'busy')).not.toBeNull()
  } finally {
    q.restore()
  }
})

test('rename without a folder on disk still renames the row', async () => {
  const db = openDb(':memory:')
  createSession(db, { slug: 'bare', goal: 'g', cwd: '/nowhere/bare', lead: 'claude' })
  const q = quiet()
  try {
    expect(await cmdRename(db, 'bare', 'dressed')).toBe(0)
    expect(getSessionBySlug(db, 'dressed')).not.toBeNull()
  } finally {
    q.restore()
  }
})
