import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { claudeAdapter } from '../src/adapters/claude'
import type { Adapter } from '../src/adapters/types'
import type { DetectDeps } from '../src/core/detect'
import { runSmoke } from '../scripts/smoke'

// runSmoke is the one place konvoy proves, against a real CLI, that a resumed binding carries
// its context. Its own logic - store a nonce, resume, demand it back - is proven here with
// fakes that either remember the nonce or do not, so a false pass or a false fail in the
// script cannot hide behind quota.
const detectDeps: DetectDeps = {
  run: async (cmd) =>
    cmd.includes('--version') ? { stdout: 'claude 9.9.9', exitCode: 0 } : { stdout: '{"loggedIn":true}', exitCode: 0 },
  readText: async () => null,
}

// A fake that behaves like a real session: remembers the nonce the first prompt carried, and
// answers with it once konvoy resumes the binding.
function fakeSession(remembers: boolean): Adapter {
  let word: string | null = null
  return {
    ...claudeAdapter,
    turn: (ctx) => {
      const stored = /secret word is (\w+)/.exec(ctx.prompt)?.[1]
      if (stored) word = stored
      const resuming = ctx.binding?.foreignId != null
      const answer = resuming ? (remembers && word ? word : 'I do not know') : 'stored'
      return {
        cmd: [
          'bun',
          'tests/fixtures/fake-agent.ts',
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-smoke' }),
          JSON.stringify({ type: 'result', subtype: 'success', result: answer }),
        ],
        cwd: process.cwd(),
      }
    },
  }
}

test('an agent whose resumed session carries the nonce passes', async () => {
  const db = openDb(':memory:')
  // one fake for both turns - send() asks adapterFor() per turn, and the memory lives in the fake
  const adapter = fakeSession(true)
  const results = await runSmoke({
    db, cfg: configSchema.parse({}), tmpDir: process.cwd(), agents: ['claude'], detectDeps, adapterFor: () => adapter,
  })
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ agent: 'claude', status: 'ok', foreignId: 'sess-smoke', resumed: true })
})

test('an agent whose resumed session forgets the nonce fails, and the reason says what was asked and what came back', async () => {
  const db = openDb(':memory:')
  const adapter = fakeSession(false)
  const results = await runSmoke({
    db, cfg: configSchema.parse({}), tmpDir: process.cwd(), agents: ['claude'], detectDeps, adapterFor: () => adapter,
  })
  expect(results[0]?.status).toBe('failed')
  expect((results[0] as { reason: string }).reason).toMatch(/resume did not carry context - stored [0-9a-f]{6}, got "I do not know"/)
})
