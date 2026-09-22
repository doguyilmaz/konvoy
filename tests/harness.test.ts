import { expect, test } from 'bun:test'
import { configSchema } from '../src/config/schema'
import { effectiveHarness, resolveAgent } from '../src/config/load'

// The report this came from: a user's first konvoy session ran claude with
// --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --setting-sources ''
// because `minimal` was the default everywhere. Their Maestro MCP was invisible, and the agent
// blamed their machine for it. `minimal` earns its keep on a turn konvoy itself drives, where
// konvoy supplies the context through the brief (design section 18 measured 2.6x less context);
// it earns nothing on a turn the user typed in their own repository with their own tools set up.
test('a turn the user drove inherits their setup, a turn konvoy drove does not', () => {
  const cfg = configSchema.parse({})
  const claude = resolveAgent(cfg, 'claude')
  expect(effectiveHarness(claude, 'user')).toBe('inherit')
  expect(effectiveHarness(claude, 'konvoy')).toBe('minimal')
})

test('an explicit harness outranks the driver, in both directions', () => {
  const pinnedMinimal = resolveAgent(configSchema.parse({ defaults: { harness: 'minimal' } }), 'claude')
  expect(effectiveHarness(pinnedMinimal, 'user')).toBe('minimal')
  expect(effectiveHarness(pinnedMinimal, 'konvoy')).toBe('minimal')

  const pinnedInherit = resolveAgent(configSchema.parse({ defaults: { harness: 'inherit' } }), 'claude')
  expect(effectiveHarness(pinnedInherit, 'user')).toBe('inherit')
  expect(effectiveHarness(pinnedInherit, 'konvoy')).toBe('inherit')

  const perAgent = resolveAgent(configSchema.parse({ agents: { claude: { harness: 'minimal' } } }), 'claude')
  expect(effectiveHarness(perAgent, 'user')).toBe('minimal')
})

test('an unconfigured harness stays unset, so the driver can still decide', () => {
  const cfg = configSchema.parse({})
  expect(resolveAgent(cfg, 'claude').harness).toBeUndefined()
  expect(resolveAgent(configSchema.parse({ defaults: { harness: 'minimal' } }), 'kiro').harness).toBe('minimal')
})
