import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { acquireLock, getBinding, lockOwner, upsertBinding, usageForSession } from '../src/store/queries'
import { newSession, send, slugify, uniqueSlug } from '../src/core/session'
import { configSchema } from '../src/config/schema'
import { claudeAdapter } from '../src/adapters/claude'
import { kiroAdapter } from '../src/adapters/kiro'
import { withPrelude, type Adapter } from '../src/adapters/types'
import type { AgentId } from '../src/types'

const cfg = configSchema.parse({})

const scripted = (lines: unknown[], exitCode = 0): Adapter => ({
  ...claudeAdapter,
  turn: (ctx) => ({
    cmd: ['bun', 'tests/fixtures/fake-agent.ts', ...lines.map((l) => JSON.stringify(l))],
    env: { ...process.env, FAKE_AGENT_EXIT: String(exitCode) } as Record<string, string>,
    cwd: process.cwd(),
  }),
})

test('a goal becomes a readable slug', () => {
  expect(slugify('Refactor the Auth Layer!')).toBe('refactor-the-auth-layer')
  expect(slugify('   ')).toBe('session')
  expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(40)
})

test('slug collisions get a numeric suffix', () => {
  const db = openDb(':memory:')
  newSession(db, { cwd: '/x', goal: 'auth', lead: 'claude' })
  expect(uniqueSlug(db, 'auth')).toBe('auth-2')
})

test('a new session is active and has no bindings yet', () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: '/x', goal: 'auth work', lead: 'claude' })
  expect(s.slug).toBe('auth-work')
  expect(s.status).toBe('active')
  expect(getBinding(db, s.id, 'claude')).toBe(null)
})

test('send binds the agent on its first turn', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const adapter = scripted([
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'result', subtype: 'success', result: 'ok' },
  ])
  const r = await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
  expect(r.final).toBe('ok')
  expect(getBinding(db, s.id, 'claude')?.foreignId).toBe('sess-1')
})

// The brief's gate.test.ts calls runGate directly, so it never proves send() actually wires
// it up — a call site bug (wrong session, wrong turnId, or no call at all) would slip past it.
test('send runs the configured gate after a successful turn', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const adapter = scripted([
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'result', subtype: 'success', result: 'ok' },
  ])
  const gated = configSchema.parse({ gate: { command: 'true' } })
  await send({ db, cfg: gated, adapterFor: () => adapter }, s, 'claude', 'hello')
  const row = usageForSession(db, s.id)[0]!
  expect(row.gateKnown).toBe(1)
  expect(row.gatePassed).toBe(1)
})

test('send does not gate a turn that failed', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const adapter = scripted([], 1)
  const gated = configSchema.parse({ gate: { command: 'false' } })
  await send({ db, cfg: gated, adapterFor: () => adapter }, s, 'claude', 'hello')
  const row = usageForSession(db, s.id)[0]!
  expect(row.gateKnown).toBe(0)
})

test('a failed resume rebinds instead of failing the turn', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  upsertBinding(db, { sessionId: s.id, agent: 'claude', foreignId: 'gone', effort: 'high', permission: 'edit' })

  let call = 0
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: (ctx) => {
      call++
      const resuming = ctx.binding?.foreignId != null
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          ...(resuming
            ? [JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID' })]
            : [
                JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-new' }),
                JSON.stringify({ type: 'result', subtype: 'success', result: 'recovered' }),
              ]),
        ],
        cwd: process.cwd(),
      }
    },
  }

  const r = await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
  expect(call).toBe(2)
  expect(r.final).toBe('recovered')
  expect(getBinding(db, s.id, 'claude')?.foreignId).toBe('sess-new')
})

test('a session already locked by a live process refuses a second turn', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  acquireLock(db, s.id, 'someone-else')
  expect(send({ db, cfg, adapterFor: () => scripted([]) }, s, 'claude', 'hi')).rejects.toThrow(/is busy/)
})

test("a rejected turn leaves the existing holder's lock alone", async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  acquireLock(db, s.id, 'someone-else')
  await expect(send({ db, cfg, adapterFor: () => scripted([]) }, s, 'claude', 'hi')).rejects.toThrow(/is busy/)
  expect(lockOwner(db, s.id)).toBe('someone-else')
})

test('a first turn that fails is not retried', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  let call = 0
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => {
      call++
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID' }),
        ],
        cwd: process.cwd(),
      }
    },
  }
  const r = await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
  expect(call).toBe(1)
  expect(r.error).not.toBe(null)
})

test('an auth failure phrased like a missing session is surfaced, not rebound', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  upsertBinding(db, { sessionId: s.id, agent: 'claude', foreignId: 'alive', effort: 'high', permission: 'edit' })
  let call = 0
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => {
      call++
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key — session not found for this account' }),
        ],
        env: { ...process.env, FAKE_AGENT_EXIT: '1' } as Record<string, string>,
        cwd: process.cwd(),
      }
    },
  }
  const r = await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
  expect(call).toBe(1)
  expect(r.error?.kind).toBe('auth')
  expect(getBinding(db, s.id, 'claude')?.foreignId).toBe('alive')
})

test('a crash after real tool work is not treated as a dead session', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  upsertBinding(db, { sessionId: s.id, agent: 'claude', foreignId: 'alive', effort: 'high', permission: 'edit' })
  let call = 0
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => {
      call++
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }),
          JSON.stringify({ type: 'result', is_error: true, result: 'no rollout found for thread id x' }),
        ],
        env: { ...process.env, FAKE_AGENT_EXIT: '1' } as Record<string, string>,
        cwd: process.cwd(),
      }
    },
  }
  await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
  expect(call).toBe(1)
  expect(getBinding(db, s.id, 'claude')?.foreignId).toBe('alive')
})

test('a crash with a stale-looking message but real output is not treated as a dead session', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  upsertBinding(db, { sessionId: s.id, agent: 'claude', foreignId: 'alive', effort: 'high', permission: 'edit' })
  let call = 0
  const adapter: Adapter = {
    ...claudeAdapter,
    turn: () => {
      call++
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial work' }] } }),
          JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID' }),
        ],
        env: { ...process.env, FAKE_AGENT_EXIT: '1' } as Record<string, string>,
        cwd: process.cwd(),
      }
    },
  }
  await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
  expect(call).toBe(1)
  expect(getBinding(db, s.id, 'claude')?.foreignId).toBe('alive')
})

test('an inherited lease does not deadlock against the process that already holds it', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const lease = 'parent-lease'
  acquireLock(db, s.id, lease)
  const prevLease = Bun.env.KONVOY_LEASE
  Bun.env.KONVOY_LEASE = lease
  try {
    const adapter = scripted([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', result: 'ok' },
    ])
    const r = await send({ db, cfg, adapterFor: () => adapter }, s, 'claude', 'hello')
    expect(r.final).toBe('ok')
    expect(lockOwner(db, s.id)).toBe(lease)
  } finally {
    if (prevLease === undefined) delete Bun.env.KONVOY_LEASE
    else Bun.env.KONVOY_LEASE = prevLease
  }
})

test('send refuses cleanly when the agent binary is not installed', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const missing = configSchema.parse({ agents: { codex: { bin: 'konvoy-test-nonexistent-binary-xyz' } } })
  await expect(send({ db, cfg: missing }, s, 'codex', 'hi')).rejects.toThrow(/codex: not installed/)
})

test('a disabled agent is refused with a clear message', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const disabled = configSchema.parse({ agents: { kiro: { enabled: false } } })
  expect(
    send({ db, cfg: disabled, adapterFor: () => scripted([]) }, s, 'kiro', 'hi'),
  ).rejects.toThrow(/kiro is disabled/)
})

test('the agent taking over receives what the previous one did, not a bare question', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'refactor the auth layer', lead: 'codex' })

  const seen: Record<string, string> = {}
  let codexCalls = 0
  const answer = (text: string) => [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: `sess-${text}` }),
    JSON.stringify({ type: 'result', subtype: 'success', result: text }),
  ]
  const adapterFor = (agent: AgentId): Adapter => ({
    ...claudeAdapter,
    id: agent,
    turn: (ctx) => {
      seen[agent] = withPrelude(ctx)
      if (agent === 'codex') codexCalls++
      const lines =
        agent !== 'codex'
          ? answer('reviewed it')
          : codexCalls === 1
            ? answer('moved refresh into AuthClient')
            : [JSON.stringify({ type: 'result', is_error: true, result: "You've hit your weekly limit" })]
      return { cmd: ['bun', 'tests/fixtures/fake-agent.ts', ...lines], cwd: process.cwd() }
    },
  })

  const cfg = configSchema.parse({ failover: { chain: ['codex', 'claude'] } })
  await send({ db, cfg, adapterFor }, s, 'codex', 'start with token refresh')

  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await send({ db, cfg, adapterFor }, s, 'codex', 'now review it')
  } finally {
    err.mockRestore()
  }

  // every piece of this was unit-tested and none of it was reachable: buildPrelude worked,
  // withPrelude worked, and nothing populated ctx.prelude, so a successor agent arrived blind
  expect(seen.claude).toContain('refactor the auth layer')
  expect(seen.claude).toContain('moved refresh into AuthClient')
  expect(seen.claude).toContain('now review it')
})

// Measured against kiro-cli 2.22.1 on 2026-09-21 by resuming a truncated session id: it exits
// 1 with `error: ACP load_session failed` on stderr and emits no stream events at all. The
// comment above STALE recorded the opposite — that kiro silently opens an empty session under
// whatever id it is handed — which was captured on 2026-09-19 and is no longer what it does.
// That wording matters because it is the only thing standing between a dead binding and a
// rebind: a resume that fails this way must clear the foreign id and start fresh, not fail
// the turn. Truncated ids are not hypothetical — kiro's own `/session-id` panel prints the
// resume command on a line it wraps, so the id shown there is short by its last characters.
test('a kiro resume that cannot load the session rebinds instead of failing the turn', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'kiro' })
  upsertBinding(db, { sessionId: s.id, agent: 'kiro', foreignId: 'gone', effort: 'high', permission: 'edit' })

  let call = 0
  const adapter: Adapter = {
    ...kiroAdapter,
    turn: (ctx) => {
      call++
      const resuming = ctx.binding?.foreignId != null
      if (resuming) {
        return {
          cmd: ['bun', 'tests/fixtures/fake-agent.ts'],
          cwd: process.cwd(),
          env: { ...(process.env as Record<string, string>), FAKE_AGENT_EXIT: '1', FAKE_AGENT_STDERR: 'error: ACP load_session failed' },
        }
      }
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          JSON.stringify({ type: 'metadata', data: { sessionId: 'kiro-new' } }),
          JSON.stringify({ type: 'runFinished', data: { status: 'success', finalText: 'recovered' } }),
        ],
        cwd: process.cwd(),
      }
    },
  }

  const r = await send({ db, cfg, adapterFor: () => adapter }, s, 'kiro', 'hello')
  expect(call).toBe(2)
  expect(r.final).toBe('recovered')
  expect(getBinding(db, s.id, 'kiro')?.foreignId).toBe('kiro-new')
})
