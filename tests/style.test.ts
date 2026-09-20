import { expect, test } from 'bun:test'
import { configSchema } from '../src/config/schema'
import { resolveAgent } from '../src/config/load'
import { claudeAdapter } from '../src/adapters/claude'
import { withPrelude } from '../src/adapters/types'

const ctx = (over: Record<string, unknown>) =>
  ({
    sessionId: 'x', slug: 's', cwd: '/x', sessionDir: '/x/.konvoy/s',
    prompt: 'THEPROMPT', binding: null, effort: 'high', permission: 'edit',
    ...over,
  }) as never

test('brief is off unless asked for', () => {
  const cfg = configSchema.parse({})
  expect(resolveAgent(cfg, 'claude').style).toBeUndefined()
})

test('an agent may be brief while the others are not', () => {
  const cfg = configSchema.parse({ agents: { claude: { style: 'brief' } } })
  expect(resolveAgent(cfg, 'claude').style).toBe('brief')
  expect(resolveAgent(cfg, 'codex').style).toBeUndefined()
})

test('defaults apply to every agent, and an agent may still opt out', () => {
  const cfg = configSchema.parse({ defaults: { style: 'brief' }, agents: { codex: { style: null } } })
  expect(resolveAgent(cfg, 'claude').style).toBe('brief')
  expect(resolveAgent(cfg, 'codex').style).toBeUndefined()
})

test('the instruction follows the prompt, because the prelude in front of it is cached', () => {
  const composed = withPrelude(ctx({ prelude: 'THEPRELUDE', style: 'brief' }))
  expect(composed.indexOf('THEPRELUDE')).toBeLessThan(composed.indexOf('THEPROMPT'))
  expect(composed.indexOf('THEPROMPT')).toBeLessThan(composed.indexOf('Lead with'))
})

test('without brief the prompt is not decorated at all', () => {
  expect(withPrelude(ctx({}))).toBe('THEPROMPT')
})

test('the instruction reaches the command line', () => {
  const line = claudeAdapter.turn(ctx({ style: 'brief' })).cmd.join(' ')
  expect(line).toContain('Lead with')
})
