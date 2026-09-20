import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { cmdNew } from '../src/commands/new'

// `konvoy rm` deletes the session row but leaves `.konvoy/<slug>/` — what lives outside the
// database is the user's. The slug is then free again, and `konvoy new` with the same goal
// wrote a fresh LEDGER.md over the old one. The ledger is append-only shared memory (spec §5);
// a new session under an old slug adds to it and adds its goal to CONTEXT.md, truncating neither.
test('a new session under a slug whose files still exist keeps the old ledger and context', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  await Bun.$`mkdir -p ${dir}/.konvoy/fix-auth`.quiet()
  await Bun.write(`${dir}/.konvoy/fix-auth/LEDGER.md`, '# Ledger — fix-auth\n- old entry\n')
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
