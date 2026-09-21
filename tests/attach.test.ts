import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, upsertBinding } from '../src/store/queries'
import { attachPlan, cmdAttach } from '../src/commands/attach'

function seeded() {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'claude' })
  upsertBinding(db, { sessionId: s.id, agent: 'codex', foreignId: 'thread-7', effort: 'high', permission: 'edit' })
  return { db, s }
}

test('attaching a bound agent resumes its own session', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'codex').cmd).toEqual(['codex', 'resume', 'thread-7'])
})

test('attaching an unbound agent starts it fresh', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'kiro').cmd).toEqual(['kiro-cli', 'chat'])
})

test('a configured binary path replaces the default command name', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'codex', '/opt/codex/bin/codex').cmd[0]).toBe('/opt/codex/bin/codex')
})

test('the attach plan runs in the session directory', () => {
  const { db, s } = seeded()
  expect(attachPlan(db, s, 'codex').cwd).toBe('/x')
})

test('attach against an uninstalled agent prints the friendly line, not a raw spawn error', async () => {
  const { db } = seeded()
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const code = await cmdAttach(db, '/x', 'codex', { slug: 'demo', bin: 'konvoy-test-nonexistent-binary-xyz' })
    expect(code).toBe(2)
    expect(err.mock.calls.some((c) => String(c[0]).includes('codex: not installed'))).toBe(true)
  } finally {
    err.mockRestore()
  }
})

// A session the user started in a CLI's own TUI — kiro prints its id and the resume command
// under /session-id — could not be handed to konvoy: foreignId was only ever written from a
// parsed stream. Adopting one binds it; the next turn resumes it; the id shape check at the
// write path still applies, and a refused id leaves the binding unbound and attach exits 2.
test('adopting a foreign session binds it so attach and the next turn resume it', async () => {
  const { adoptForeignSession } = await import('../src/commands/attach')
  const { getBinding } = await import('../src/store/queries')
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: '/x', lead: 'kiro' })
  expect(adoptForeignSession(db, s, 'kiro', 'cli_800eb035-b675-4d9d-8f81-c6b661c12936_de1B0Hdt', { effort: 'high', permission: 'edit' })).toBe(true)
  expect(getBinding(db, s.id, 'kiro')?.status).toBe('bound')
  expect(attachPlan(db, s, 'kiro').cmd).toEqual(['kiro-cli', 'chat', '--resume-id', 'cli_800eb035-b675-4d9d-8f81-c6b661c12936_de1B0Hdt'])
})

test('adopting an id that is not an id shape is refused and attach does not open anything', async () => {
  const { adoptForeignSession } = await import('../src/commands/attach')
  const { getBinding } = await import('../src/store/queries')
  const { spyOn } = await import('bun:test')
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 'demo', goal: 'g', cwd: process.cwd(), lead: 'kiro' })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(adoptForeignSession(db, s, 'kiro', '--trust-all-tools', { effort: 'high', permission: 'edit' })).toBe(false)
    expect(getBinding(db, s.id, 'kiro')?.foreignId ?? null).toBeNull()
    // `true --version` exits 0, so detection passes and the refusal is what stops the command
    expect(await cmdAttach(db, process.cwd(), 'kiro', { slug: 'demo', bin: 'true', id: '--trust-all-tools', effort: 'high', permission: 'edit' })).toBe(2)
  } finally {
    err.mockRestore()
  }
})
