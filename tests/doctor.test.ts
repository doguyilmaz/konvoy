import { expect, spyOn, test } from 'bun:test'
import { configSchema, type Config } from '../src/config/schema'
import { cmdDoctor } from '../src/commands/doctor'
import { detect, detectAuth } from '../src/core/detect'

function cfg(over: Record<string, unknown>): Config {
  return configSchema.parse(over)
}

test('a role naming a disabled agent fails doctor', async () => {
  const bin = 'doctor-test-lead-b'
  await detect('claude', {
    bin,
    deps: { run: async () => ({ stdout: '2.1.278', exitCode: 0 }), readText: async () => null },
  })
  await detectAuth('claude', {
    bin,
    deps: { run: async () => ({ stdout: '{"loggedIn":true}', exitCode: 0 }), readText: async () => null },
  })

  const config = cfg({
    agents: {
      claude: { bin },
      codex: { enabled: false },
      kiro: { enabled: false },
      opencode: { enabled: false },
    },
    roles: { reviewer: 'codex' },
  })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  let code: number
  try {
    code = await cmdDoctor(config)
  } finally {
    log.mockRestore()
  }
  expect(code).toBe(1)
})

test('an agent that fails auth is reported once, not also as ok', async () => {
  const bin = 'doctor-test-lead-c'
  await detect('claude', {
    bin,
    deps: { run: async () => ({ stdout: '2.1.278', exitCode: 0 }), readText: async () => null },
  })
  await detectAuth('claude', {
    bin,
    deps: { run: async () => ({ stdout: '{"loggedIn":false}', exitCode: 0 }), readText: async () => null },
  })

  const config = cfg({
    agents: {
      claude: { bin },
      codex: { enabled: false },
      kiro: { enabled: false },
      opencode: { enabled: false },
    },
  })

  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    await cmdDoctor(config)
  } finally {
    lines = log.mock.calls.map((c) => String(c[0]))
    log.mockRestore()
  }

  expect(lines.some((l) => l.startsWith('x claude:'))).toBe(true)
  expect(lines.some((l) => l.startsWith('ok claude:'))).toBe(false)
})
