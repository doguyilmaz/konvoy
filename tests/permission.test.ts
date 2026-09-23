import { expect, test } from 'bun:test'
import { configSchema, permissionSchema } from '../src/config/schema'
import { adapters } from '../src/adapters'
import { resolveAgent } from '../src/config/load'
import type { TurnContext } from '../src/types'

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  sessionId: 'x', slug: 's', cwd: '/repo', sessionDir: '/repo/.konvoy/s',
  prompt: 'go', binding: null, effort: 'high', permission: 'edit', ...over,
})

const line = (agent: keyof typeof adapters, permission: string): string =>
  adapters[agent].turn(ctx({ permission: permission as never })).cmd.join(' ')

// A headless turn has nobody to answer a permission prompt, so `edit` refuses every tool that
// asks: that is how a user's maestro, xcrun and adb calls came back as eighteen dots and no
// work. Two of the four CLIs have a mode built for exactly this - claude's `auto` ("runs
// everything, with background safety checks") and codex's `--approve-for-me` ("route approval
// requests through automatic review using the workspace-write sandbox") - so konvoy gains the
// level rather than quietly widening `edit`, which is the default everybody already runs.
test('auto is a permission level of its own, between edit and yolo', () => {
  expect(permissionSchema.options).toEqual(['safe', 'edit', 'auto', 'yolo'])
  expect(configSchema.parse({ defaults: { permission: 'auto' } }).defaults.permission).toBe('auto')
  expect(resolveAgent(configSchema.parse({ agents: { kiro: { permission: 'auto' } } }), 'kiro').permission).toBe('auto')
})

test('claude auto asks for background safety checks instead of refusing what it cannot ask about', () => {
  expect(line('claude', 'auto')).toContain('--permission-mode auto')
  // the levels either side are untouched
  expect(line('claude', 'edit')).toContain('--permission-mode acceptEdits')
  expect(line('claude', 'yolo')).toContain('--permission-mode bypassPermissions')
})

// `--approve-for-me` sets the workspace-write sandbox itself and is MUTUALLY EXCLUSIVE with `-s`:
// a live turn on codex 0.156.1 exited 2 with "the argument '--sandbox <SANDBOX_MODE>' cannot be
// used with '--approve-for-me'". verify:claims cannot see this - both flags exist on their own -
// so the combination is pinned here instead.
test('codex auto routes approvals through automatic review, and never alongside -s', () => {
  const auto = line('codex', 'auto')
  expect(auto).toContain('--approve-for-me')
  expect(auto).not.toContain('-s ')
  expect(auto).not.toContain('--sandbox')
  // the levels either side keep their sandbox, which is not exclusive with anything
  expect(line('codex', 'edit')).toContain('-s workspace-write')
  expect(line('codex', 'edit')).not.toContain('--approve-for-me')
  expect(line('codex', 'safe')).toContain('-s read-only')
  expect(line('codex', 'yolo')).toContain('--dangerously-bypass-approvals-and-sandbox')
})

test('opencode auto auto-approves everything it is not explicitly denied', () => {
  expect(line('opencode', 'auto')).toContain('--auto')
  expect(line('opencode', 'edit')).not.toContain('--auto')
})

// kiro-cli 2.23.0 `chat --help` offers only `--trust-all-tools` and `--trust-tools=<list>`:
// there is no automatic-review mode to map onto, so `auto` trusts the same tools `edit` does.
// Saying that here is the point - a row that quietly became `--trust-all-tools` would mean
// `auto` was silently yolo on one agent of four.
test('kiro has no auto-review mode, so auto trusts what edit trusts and no more', () => {
  expect(line('kiro', 'auto')).toBe(line('kiro', 'edit'))
  expect(line('kiro', 'auto')).not.toContain('--trust-all-tools')
})

test('every agent has a row for every level, so no level falls through to a default', () => {
  for (const agent of Object.keys(adapters) as (keyof typeof adapters)[]) {
    for (const permission of permissionSchema.options) {
      expect(() => line(agent, permission), `${agent} ${permission}`).not.toThrow()
    }
  }
})
