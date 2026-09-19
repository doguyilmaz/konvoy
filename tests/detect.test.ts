import { expect, test } from 'bun:test'
import { detectWith, parseVersion, detectAuthWith, clearDetectCache, detect, detectAuth } from '../src/core/detect'

const deps = (over: Partial<Parameters<typeof detectWith>[0]> = {}) => ({
  run: async () => ({ stdout: '', exitCode: 127 }),
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

test('the right model is found among several in the cache', async () => {
  const cache = JSON.stringify({
    models: [
      { id: 'other', supported_reasoning_levels: ['low'] },
      { id: 'gpt-6-astra', supported_reasoning_levels: ['low', 'medium', 'high', 'max'] },
    ],
  })
  const d = await detectWith(
    deps({ run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }), readText: async () => cache }),
    'codex',
    'gpt-6-astra',
  )
  expect(d.efforts).toEqual(['low', 'medium', 'high', 'max'])
})

test('a logged-in status is read from json when the cli emits it', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', exitCode: 0 }) }),
    'claude',
  )
  expect(a.authed).toBe(true)
})

test('a logged-out status is believed even at exit zero', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{"loggedIn":false}', exitCode: 0 }) }),
    'claude',
  )
  expect(a.authed).toBe(false)
})

test('a missing binary makes auth unknown rather than false', async () => {
  const a = await detectAuthWith(deps({ run: async () => ({ stdout: '', exitCode: 127 }) }), 'kiro')
  expect(a.authed).toBe(null)
})

test('a failing status command is not believed, whatever it printed', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: 'stale: Logged in using ChatGPT, but refresh failed', exitCode: 1 }) }),
    'codex',
  )
  expect(a.authed).toBe(null)
})

test('an explicit json verdict is trusted even when the exit code is not zero', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{"loggedIn":false}', exitCode: 1 }) }),
    'claude',
  )
  expect(a.authed).toBe(false)
})

test('the cli own words are carried through for the user to read', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: 'Logged in with IAM Identity Center\nEmail: x@y.z', exitCode: 0 }) }),
    'kiro',
  )
  expect(a.authed).toBe(true)
  expect(a.detail).toBe('Logged in with IAM Identity Center')
})

test('a memoized detect rejection does not stick', async () => {
  clearDetectCache()
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls === 1) throw new Error('transient')
    return { stdout: 'codex-cli 0.155.1', exitCode: 0 }
  }
  const testDeps = deps({ run: flaky })
  await expect(detect('codex', undefined, testDeps)).rejects.toThrow()
  const second = await detect('codex', undefined, testDeps)
  expect(second.installed).toBe(true)
})

test('a memoized detectAuth rejection does not stick', async () => {
  clearDetectCache()
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls === 1) throw new Error('transient')
    return { stdout: '{"loggedIn":true}', exitCode: 0 }
  }
  const testDeps = deps({ run: flaky })
  await expect(detectAuth('claude', undefined, testDeps)).rejects.toThrow()
  const second = await detectAuth('claude', undefined, testDeps)
  expect(second.authed).toBe(true)
})
