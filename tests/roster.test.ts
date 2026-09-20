import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, upsertBinding } from '../src/store/queries'
import { loadConfig } from '../src/config/load'
import { cmdRoster } from '../src/commands/roster'

const tmp = (name: string) => `/tmp/konvoy-test-roster-${name}-${Bun.nanoseconds()}`

test('cmdRoster uses a single bindings query', async () => {
  const dir = tmp('cfg')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })

  const d = openDb(':memory:')
  const s = createSession(d, { slug: 's', goal: 'ship it', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'thread-1', effort: 'high', permission: 'edit' })
  upsertBinding(d, { sessionId: s.id, agent: 'codex', foreignId: 'thread-2', effort: 'high', permission: 'edit' })

  const querySpy = spyOn(d, 'query')
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const code = cmdRoster(d, cfg, '/x')
    expect(code).toBe(0)
    const bindingQueries = querySpy.mock.calls.filter((c) => String(c[0]).includes('FROM binding'))
    expect(bindingQueries).toHaveLength(1)
  } finally {
    querySpy.mockRestore()
    log.mockRestore()
  }
})

test('cmdRoster still shows each agent bound status correctly', async () => {
  const dir = tmp('cfg2')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })

  const d = openDb(':memory:')
  const s = createSession(d, { slug: 's', goal: 'ship it', cwd: '/x', lead: 'claude' })
  upsertBinding(d, { sessionId: s.id, agent: 'claude', foreignId: 'thread-1', effort: 'high', permission: 'edit' })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    cmdRoster(d, cfg, '/x')
    const output = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('claude')
    expect(output).toContain('bound')
    expect(output).toContain('unbound')
  } finally {
    log.mockRestore()
  }
})
