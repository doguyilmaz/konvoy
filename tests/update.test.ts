import { expect, spyOn, test } from 'bun:test'
import { clearDetectCache, detect } from '../src/core/detect'
import { cmdUpdate } from '../src/commands/update'
import { configSchema } from '../src/config/schema'
import { updatePlan } from '../src/core/install'
import type { AgentId } from '../src/types'

// the CLI's own updater, used when no package manager owns the binary
function selfUpdate(agent: AgentId, bin: string): string[] | null {
  const plan = updatePlan(agent, 'unknown', bin)
  return 'argv' in plan ? plan.argv : null
}

test('each agent has its own update command', () => {
  // verified against the installed CLIs: claude/codex/kiro-cli take `update`, opencode takes `upgrade`
  expect(selfUpdate('claude', 'claude')).toEqual(['claude', 'update'])
  expect(selfUpdate('codex', 'codex')).toEqual(['codex', 'update'])
  expect(selfUpdate('opencode', 'opencode')).toEqual(['opencode', 'upgrade'])
  expect(selfUpdate('kiro', 'kiro-cli')).toEqual(['kiro-cli', 'update'])
})

test('a configured binary replaces the name the update runs', () => {
  expect(selfUpdate('opencode', '/Users/x/.opencode/bin/opencode')).toEqual(['/Users/x/.opencode/bin/opencode', 'upgrade'])
})

test('update skips a disabled agent, runs a configured one, and forwards the configured bin to detect', async () => {
  const ran: string[][] = []
  const detectCalls: { agent: AgentId; opts: { bin?: string } }[] = []
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const code = await cmdUpdate(
    configSchema.parse({
      agents: {
        claude: { enabled: false },
        codex: { enabled: false },
        kiro: { enabled: false },
        antigravity: { enabled: false },
        opencode: { bin: '/custom/opencode' },
      },
    }),
    { all: true },
    {
      detect: async (agent, opts) => {
        detectCalls.push({ agent, opts })
        return { agent: 'opencode' as const, installed: true, version: '2.0.10' }
      },
      spawn: async (argv: string[]) => {
        ran.push(argv)
        return 0
      },
      origin: () => ({ channel: 'unknown' }),
      self: () => 'by hand',
    },
  )
  log.mockRestore()
  expect(ran).toEqual([['/custom/opencode', 'upgrade']])
  expect(code).toBe(0)
  // both the before- and after-spawn detect calls must carry the configured bin, not the bare name
  expect(detectCalls).toEqual([
    { agent: 'opencode', opts: { bin: '/custom/opencode' } },
    { agent: 'opencode', opts: { bin: '/custom/opencode' } },
  ])
})

test('a non-zero spawn exit is reported, counted as a failure, and does not stop the loop', async () => {
  const ran: string[][] = []
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const code = await cmdUpdate(
      configSchema.parse({
        agents: {
          codex: { enabled: false },
          kiro: { enabled: false },
          opencode: { bin: '/custom/opencode' },
        },
      }),
      { all: true },
      {
        detect: async (agent) => ({
          agent,
          installed: true,
          version: agent === 'claude' ? '1.0.0' : '2.0.10',
        }),
        spawn: async (argv) => {
          ran.push(argv)
          return argv[0] === 'claude' ? 1 : 0
        },
        origin: () => ({ channel: 'unknown' }),
        self: () => 'by hand',
      },
    )
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(code).toBe(1)
    // claude fails but the loop still reaches every agent after it in agentIds
    expect(ran).toEqual([
      ['claude', 'update'],
      ['/custom/opencode', 'upgrade'],
      ['agy', 'update'],
    ])
    expect(lines).toContain('! claude: update exited with 1')
    expect(lines).toContain('ok opencode: 2.0.10 -> 2.0.10')
  } finally {
    log.mockRestore()
  }
})

// realUpdateDeps.detect is the memoized detect, keyed by agent, model and bin - identical before
// and after the spawn, so the "after" version came from the memo and every update printed
// "X -> X". The suite's own output showed "ok opencode: 2.0.10 -> 2.0.10". This drives the real
// memoized detect with an injected --version whose answer changes when the update runs.
test('after an update the reported version comes from a fresh detect, not the memo', async () => {
  clearDetectCache()
  let version = '1.0.0'
  const deps = { run: async () => ({ stdout: `claude ${version}`, exitCode: 0 }), readText: async () => null }
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await cmdUpdate(
      configSchema.parse({ agents: { codex: { enabled: false }, kiro: { enabled: false }, opencode: { enabled: false } } }),
      { all: true },
      {
        detect: (agent, opts) => detect(agent, { ...opts, deps }),
        spawn: async () => {
          version = '2.0.0'
          return 0
        },
        origin: () => ({ channel: 'unknown' }),
        self: () => 'by hand',
      },
    )
    expect(log.mock.calls.map((c) => String(c[0]))).toContain('ok claude: 1.0.0 -> 2.0.0')
  } finally {
    log.mockRestore()
    clearDetectCache()
  }
})
