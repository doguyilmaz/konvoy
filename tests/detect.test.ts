import { expect, test } from 'bun:test'
import { detectWith, parseVersion } from '../src/core/detect'

const deps = (over: Partial<Parameters<typeof detectWith>[0]> = {}) => ({
  run: async () => ({ stdout: '', exitCode: 127 }),
  exists: async () => false,
  readText: async () => null,
  ...over,
})

test('a version string is extracted from noisy output', () => {
  expect(parseVersion('2.1.278 (Claude Code)')).toBe('2.1.278')
  expect(parseVersion('codex-cli 0.155.1')).toBe('0.155.1')
  expect(parseVersion('command not found')).toBe(null)
})

test('a missing binary reports not installed', async () => {
  const d = await detectWith(deps(), 'claude')
  expect(d.installed).toBe(false)
  expect(d.version).toBe(null)
})

test('an installed binary reports its version', async () => {
  const d = await detectWith(deps({ run: async () => ({ stdout: 'kiro-cli 2.22.1', exitCode: 0 }) }), 'kiro')
  expect(d.installed).toBe(true)
  expect(d.version).toBe('2.22.1')
})

test('codex auth is inferred from its credentials file', async () => {
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      exists: async (p: string) => p.endsWith('.codex/auth.json'),
    }),
    'codex',
  )
  expect(d.authed).toBe(true)
})

test('codex effort capabilities come from the model cache', async () => {
  const cache = JSON.stringify({
    models: [{ id: 'gpt-6-astra', supported_reasoning_levels: ['low', 'medium', 'high', 'max'] }],
  })
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async (p: string) => (p.endsWith('models_cache.json') ? cache : null),
    }),
    'codex',
    'gpt-6-astra',
  )
  expect(d.efforts).toEqual(['low', 'medium', 'high', 'max'])
})

test('a model cache whose shape is not what we captured yields no capabilities', async () => {
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async () => JSON.stringify({ models: { id: 'gpt-6-astra' } }),
    }),
    'codex',
    'gpt-6-astra',
  )
  expect(d.efforts).toBeUndefined()
})

test('a supported-level field that is not a list is rejected', async () => {
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async () => JSON.stringify({ models: [{ id: 'm', supported_reasoning_levels: 'low,high' }] }),
    }),
    'codex',
    'm',
  )
  expect(d.efforts).toBeUndefined()
})

test('an unknown model leaves capabilities undefined', async () => {
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async () => JSON.stringify({ models: [] }),
    }),
    'codex',
    'nope',
  )
  expect(d.efforts).toBeUndefined()
})
