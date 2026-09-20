import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, recordTurn, usageForSession } from '../src/store/queries'
import { configSchema } from '../src/config/schema'
import { runGate, splitCommand } from '../src/core/gate'
import { loadConfig } from '../src/config/load'

const seed = () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: process.cwd(), lead: 'claude' })
  const turnId = recordTurn(db, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0 })
  return { db, s, turnId }
}

test('no gate configured records no verdict', async () => {
  const { db, s, turnId } = seed()
  await runGate(db, configSchema.parse({}), s, turnId)
  expect(usageForSession(db, s.id)[0]!.gateKnown).toBe(0)
})

test('a command that exits zero records a pass', async () => {
  const { db, s, turnId } = seed()
  await runGate(db, configSchema.parse({ gate: { command: 'true' } }), s, turnId)
  const row = usageForSession(db, s.id)[0]!
  expect(row.gateKnown).toBe(1)
  expect(row.gatePassed).toBe(1)
})

test('a command that exits non-zero records a failure, and does not throw', async () => {
  const { db, s, turnId } = seed()
  await runGate(db, configSchema.parse({ gate: { command: 'false' } }), s, turnId)
  const row = usageForSession(db, s.id)[0]!
  expect(row.gateKnown).toBe(1)
  expect(row.gatePassed).toBe(0)
})

test('a turn that failed is not gated, because it has nothing for the gate to judge', async () => {
  const db = openDb(":memory:")
  const s = createSession(db, { slug: 's', goal: 'g', cwd: process.cwd(), lead: 'claude' })
  // the agent was blocked; running the suite now would blame it for the block
  const turnId = recordTurn(db, {
    sessionId: s.id, agent: 'claude', prompt: 'p', final: '', costUsd: 0,
    exitCode: 1, error: 'rate limited',
  })
  await runGate(db, configSchema.parse({ gate: { command: 'false' } }), s, turnId)
  expect(usageForSession(db, s.id)[0]!.gateKnown).toBe(0)
})

test('a command that cannot run is a missing verdict, not a failing one', async () => {
  const { db, s, turnId } = seed()
  await runGate(db, configSchema.parse({ gate: { command: 'definitely-not-a-real-binary-xyz' } }), s, turnId)
  // "the gate could not run" and "the work failed" are different facts and must not be conflated
  expect(usageForSession(db, s.id)[0]!.gateKnown).toBe(0)
})

test('a project layer cannot name the gate command, because konvoy runs it unprompted', async () => {
  const dir = `/tmp/konvoy-gate-${Bun.nanoseconds()}`
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ gate: { command: "touch /tmp/pwned" } }))
  const globalPath = `${dir}/global.jsonc`
  await Bun.write(globalPath, JSON.stringify({ gate: { command: "true" } }))

  const err = spyOn(console, "error").mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath })
    expect(cfg.gate.command).toBe("true")
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("gate")
  } finally {
    err.mockRestore()
  }
})

// The same defect turn.ts was fixed for: Bun's `timeout` sends SIGTERM once and never follows
// up, so a gate whose test runner traps SIGTERM held the session lock forever. Measured before
// the fix at 3 s: still running. Both spawns now share one escalation.
test('a gate command that traps SIGTERM is killed after the grace and recorded as a failure', async () => {
  const { db, s, turnId } = seed()
  const t0 = Date.now()
  const done = runGate(db, configSchema.parse({ gate: { command: 'bash tests/fixtures/trap-term.sh' } }), s, turnId, { timeoutMs: 300, killGraceMs: 200 })
  const outcome = await Promise.race([done.then(() => 'finished'), Bun.sleep(3000).then(() => 'still running after 3s')])
  expect(outcome).toBe('finished')
  expect(Date.now() - t0).toBeLessThan(3000)
  const row = usageForSession(db, s.id)[0]!
  expect(row.gateKnown).toBe(1)
  expect(row.gatePassed).toBe(0)
})

// `bun test --grep "auth flow"` is one command with one quoted argument; splitting on whitespace
// alone handed the runner two half-arguments.
test('a gate command is split on whitespace outside quotes', () => {
  expect(splitCommand(`bun test --grep "auth flow" -t 'x y'`)).toEqual(['bun', 'test', '--grep', 'auth flow', '-t', 'x y'])
  expect(splitCommand('  bun   test ')).toEqual(['bun', 'test'])
  expect(splitCommand(`echo ""`)).toEqual(['echo', ''])
})
