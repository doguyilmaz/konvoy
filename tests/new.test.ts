import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { cmdNew } from '../src/commands/new'
import { listSessions } from '../src/store/queries'
import { slugify } from '../src/core/session'

// `konvoy rm` deletes the session row but leaves `.konvoy/<slug>/` - what lives outside the
// database is the user's. The slug is then free again, and `konvoy new` with the same goal
// wrote a fresh LEDGER.md over the old one. The ledger is append-only shared memory (spec §5);
// a new session under an old slug adds to it and adds its goal to CONTEXT.md, truncating neither.
test('a new session under a slug whose files still exist keeps the old ledger and context', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  await Bun.$`mkdir -p ${dir}/.konvoy/fix-auth`.quiet()
  await Bun.write(`${dir}/.konvoy/fix-auth/LEDGER.md`, '# Ledger - fix-auth\n- old entry\n')
  await Bun.write(`${dir}/.konvoy/fix-auth/CONTEXT.md`, '# fix-auth\n\n## Goal\n\nthe old goal\n')
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const code = await cmdNew(openDb(':memory:'), configSchema.parse({}), dir, 'fix auth')
    expect(code).toBe(0)
    const ledger = await Bun.file(`${dir}/.konvoy/fix-auth/LEDGER.md`).text()
    expect(ledger).toContain('- old entry')
    const context = await Bun.file(`${dir}/.konvoy/fix-auth/CONTEXT.md`).text()
    expect(context).toContain('the old goal')
    expect(context).toContain('fix auth')
  } finally {
    log.mockRestore()
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

test('a session without a goal is named after its directory with a short suffix', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  const db = openDb(':memory:')
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(await cmdNew(db, configSchema.parse({}), dir, '')).toBe(0)
    const s = listSessions(db)[0]!
    const base = slugify(dir.split('/').filter(Boolean).at(-1)!)
    expect(s.slug).toMatch(new RegExp(`^${base}-[0-9a-f]{4}$`))
    expect(s.goal).toBe('')
    const context = await Bun.file(`${dir}/.konvoy/${s.slug}/CONTEXT.md`).text()
    expect(context).toBe(`# ${s.slug}\n`)
  } finally {
    log.mockRestore()
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

test('konvoy new leaves a .gitignore in .konvoy that hides session folders, and never rewrites one', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await cmdNew(openDb(':memory:'), configSchema.parse({}), dir, 'first')
    expect(await Bun.file(`${dir}/.konvoy/.gitignore`).text()).toBe('*\n!config.jsonc\n')
    await Bun.write(`${dir}/.konvoy/.gitignore`, '# mine\n')
    await cmdNew(openDb(':memory:'), configSchema.parse({}), dir, 'second')
    expect(await Bun.file(`${dir}/.konvoy/.gitignore`).text()).toBe('# mine\n')
  } finally {
    log.mockRestore()
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})
