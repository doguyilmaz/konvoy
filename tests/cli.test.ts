import { expect, spyOn, test } from 'bun:test'
import { main, USAGE } from '../src/cli'
import { commandTable } from '../src/commands/table'

const tmp = (name: string) => `/tmp/konvoy-test-cli-${name}-${Bun.nanoseconds()}`

test('USAGE lists every dispatchable command, so it cannot drift from the table', () => {
  for (const c of commandTable) {
    expect(USAGE).toContain(`konvoy ${c.usage}`)
  }
})

async function withEnv(cwd: string, home: string, fn: () => Promise<void>): Promise<void> {
  const prevCwd = process.cwd()
  const prevHome = Bun.env.HOME
  process.chdir(cwd)
  Bun.env.HOME = home
  try {
    await fn()
  } finally {
    process.chdir(prevCwd)
    if (prevHome === undefined) delete Bun.env.HOME
    else Bun.env.HOME = prevHome
  }
}

test('a malformed project config produces one readable line and a non-zero exit, not a raw SyntaxError', async () => {
  const dir = tmp('badconfig')
  const home = tmp('badconfig-home')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{ "defaults": { "effort": }')
  await Bun.write(`${home}/marker`, '')
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    let code = -1
    await withEnv(dir, home, async () => {
      code = await main(['doctor'])
    })
    expect(code).toBe(1)
    expect(err.mock.calls.length).toBe(1)
    const message = String(err.mock.calls[0]?.[0])
    expect(message).not.toContain('SyntaxError')
    expect(message).toContain('config.jsonc')
  } finally {
    err.mockRestore()
  }
})

test('a database file that is not SQLite produces one readable line, not a raw SQLiteError', async () => {
  const dir = tmp('baddb')
  const home = tmp('baddb-home')
  await Bun.write(`${dir}/marker`, '')
  await Bun.write(`${home}/.local/share/konvoy/konvoy.db`, 'not a sqlite file, just some padding text here')
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    let code = -1
    await withEnv(dir, home, async () => {
      code = await main(['doctor'])
    })
    expect(code).toBe(1)
    expect(err.mock.calls.length).toBe(1)
    const message = String(err.mock.calls[0]?.[0])
    expect(message).not.toContain('SQLITE_NOTADB')
    expect(message).toContain('konvoy.db')
  } finally {
    err.mockRestore()
  }
})

test('KONVOY_DEBUG=1 lets the raw error escape instead of being summarised', async () => {
  const dir = tmp('debug')
  const home = tmp('debug-home')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{ "defaults": { "effort": }')
  await Bun.write(`${home}/marker`, '')
  const prevDebug = Bun.env.KONVOY_DEBUG
  Bun.env.KONVOY_DEBUG = '1'
  try {
    await withEnv(dir, home, async () => {
      await expect(main(['doctor'])).rejects.toThrow()
    })
  } finally {
    if (prevDebug === undefined) delete Bun.env.KONVOY_DEBUG
    else Bun.env.KONVOY_DEBUG = prevDebug
  }
})

