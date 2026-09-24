import { expect, test } from 'bun:test'
import { coerce, getPath, isPrivileged, setPath, unsetPath } from '../src/commands/config'
import { configSchema } from '../src/config/schema'

test('values are coerced to their obvious type', () => {
  expect(coerce('true')).toBe(true)
  expect(coerce('false')).toBe(false)
  expect(coerce('3')).toBe(3)
  expect(coerce('high')).toBe('high')
})

test('setPath creates missing intermediate objects', () => {
  expect(setPath({}, 'agents.codex.effort', 'max')).toEqual({ agents: { codex: { effort: 'max' } } })
})

test('setPath preserves siblings', () => {
  const start = { agents: { codex: { model: 'gpt-6-astra' } } }
  expect(setPath(start, 'agents.codex.effort', 'max')).toEqual({
    agents: { codex: { model: 'gpt-6-astra', effort: 'max' } },
  })
})

test('getPath reads a dotted path and returns undefined when absent', () => {
  const cfg = configSchema.parse({ agents: { kiro: { model: 'claude-sonnet-5' } } })
  expect(getPath(cfg, 'agents.kiro.model')).toBe('claude-sonnet-5')
  expect(getPath(cfg, 'agents.kiro.nothing')).toBeUndefined()
  expect(getPath(cfg, 'defaults.effort')).toBe('high')
})

test('a set that would produce an invalid config is rejected before writing', () => {
  const next = setPath({}, 'defaults.effort', 'turbo')
  expect(configSchema.safeParse(next).success).toBe(false)
})

test('a dotted path cannot reach Object.prototype', () => {
  // `config set __proto__.x` would otherwise write onto the shared prototype while the config
  // itself stayed empty - a silent no-op that poisons every object in the process
  expect(() => setPath({}, '__proto__.polluted', 'true')).toThrow()
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()

  expect(() => setPath({}, 'agents.constructor.prototype.x', 'true')).toThrow()
  expect(() => getPath({}, '__proto__')).toThrow()
})

test('ordinary keys that merely contain a reserved word still work', () => {
  expect(setPath({}, 'agents.claude.model', 'opus')).toEqual({ agents: { claude: { model: 'opus' } } })
  expect(setPath({}, 'defaults.prototypeMode', 'true')).toEqual({ defaults: { prototypeMode: true } })
})

test('a list or an object is written as JSON, so a failover chain can be set from the command line', () => {
  expect(coerce('["codex","claude"]')).toEqual(['codex', 'claude'])
  expect(coerce('{"enabled":true}')).toEqual({ enabled: true })
  expect(coerce('null')).toBe(null)
  // not JSON after all: kept as the string it was
  expect(coerce('[not json')).toBe('[not json')
  const next = setPath({}, 'failover.chain', '["codex","claude"]')
  expect(configSchema.safeParse(next).success).toBe(true)
})

test('unset removes a key and the objects it leaves empty, and says when there was nothing to remove', () => {
  const start = { agents: { codex: { model: 'gpt-6-astra' } }, defaults: { effort: 'high' } }
  expect(unsetPath(start, 'agents.codex.model')).toEqual({ next: { defaults: { effort: 'high' } }, found: true })
  expect(unsetPath(start, 'agents.kiro.model').found).toBe(false)
  expect(() => unsetPath({}, '__proto__.polluted')).toThrow()
})

// load.ts strips these from a project file at every load; writing one there reported success and
// was then ignored on every run after it
test('the keys only the global config may set are recognised before a project write', () => {
  for (const key of ['gate.command', 'defaults.permission', 'defaults.harness', 'agents.codex.bin', 'agents.claude.permission']) {
    expect(isPrivileged(key), key).toBe(true)
  }
  for (const key of ['defaults.effort', 'agents.codex.model', 'failover.chain', 'gatekeeper']) expect(isPrivileged(key), key).toBe(false)
})
