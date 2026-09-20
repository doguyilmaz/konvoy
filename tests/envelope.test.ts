import { expect, test } from 'bun:test'
import { configSchema } from '../src/config/schema'
import { resolveAgent } from '../src/config/load'
import { withPrelude } from '../src/adapters/types'
import { claudeAdapter } from '../src/adapters/claude'

const ctx = (over: Record<string, unknown>) =>
  ({
    sessionId: 'x', slug: 's', cwd: '/x', sessionDir: '/x/.konvoy/s',
    prompt: 'THEPROMPT', binding: null, effort: 'high', permission: 'edit',
    ...over,
  }) as never

test('delegation is off unless asked for', () => {
  expect(configSchema.parse({}).delegation.enabled).toBe(false)
})

test('nothing is said about envelopes when delegation is off', () => {
  expect(withPrelude(ctx({}))).toBe('THEPROMPT')
})

test('with delegation on, the agent is told how to hand work over', () => {
  const out = withPrelude(ctx({ delegation: true }))
  expect(out).toContain('<<<konvoy')
  expect(out).toContain('to:')
  expect(out).toContain('task:')
})

test('the instruction follows the prompt, because the prelude in front of it is cached', () => {
  const out = withPrelude(ctx({ prelude: 'THEPRELUDE', delegation: true }))
  expect(out.indexOf('THEPRELUDE')).toBeLessThan(out.indexOf('THEPROMPT'))
  expect(out.indexOf('THEPROMPT')).toBeLessThan(out.indexOf('<<<konvoy'))
})

test('it reaches the command line', () => {
  expect(claudeAdapter.turn(ctx({ delegation: true })).cmd.join(' ')).toContain('<<<konvoy')
})

// Not in the brief's verbatim test list — added to catch a mutation that would otherwise be
// MISSED: dropping the "emit nothing" sentence from DELEGATION_INSTRUCTION changes no other
// assertion above, since those only check for the block's presence, not its full content.
test('the instruction says a turn not handing off emits nothing', () => {
  const out = withPrelude(ctx({ delegation: true }))
  expect(out).toContain('emit nothing')
})
