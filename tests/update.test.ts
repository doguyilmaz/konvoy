import { expect, test } from 'bun:test'
import { cmdUpdate, updateCommand } from '../src/commands/update'
import { configSchema } from '../src/config/schema'

test('each agent has its own update command', () => {
  // verified against the installed CLIs: claude/codex/kiro-cli take `update`, opencode takes `upgrade`
  expect(updateCommand('claude')).toEqual(['claude', 'update'])
  expect(updateCommand('codex')).toEqual(['codex', 'update'])
  expect(updateCommand('opencode')).toEqual(['opencode', 'upgrade'])
  expect(updateCommand('kiro')).toEqual(['kiro-cli', 'update'])
})

test('a configured binary replaces the name the update runs', () => {
  expect(updateCommand('opencode', '/Users/x/.opencode/bin/opencode')).toEqual([
    '/Users/x/.opencode/bin/opencode',
    'upgrade',
  ])
})

test('update skips a disabled agent and runs a configured one', async () => {
  const ran: string[][] = []
  const code = await cmdUpdate(
    configSchema.parse({
      agents: {
        claude: { enabled: false },
        codex: { enabled: false },
        kiro: { enabled: false },
        opencode: { bin: '/custom/opencode' },
      },
    }),
    { all: true },
    {
      detect: async () => ({ agent: 'opencode' as const, installed: true, version: '2.0.10' }),
      spawn: async (argv: string[]) => {
        ran.push(argv)
        return 0
      },
    },
  )
  expect(ran).toEqual([['/custom/opencode', 'upgrade']])
  expect(code).toBe(0)
})
