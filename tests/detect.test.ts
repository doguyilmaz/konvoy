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

test('a configured binary path reaches the install check', async () => {
  const calls: string[][] = []
  const testDeps = deps({
    run: async (argv: string[]) => {
      calls.push(argv)
      return { stdout: 'opencode 2.0.10', exitCode: 0 }
    },
  })
  const d = await detectWith(testDeps, 'opencode', { bin: '/custom/path/opencode' })
  expect(calls[0]?.[0]).toBe('/custom/path/opencode')
  expect(d.installed).toBe(true)
})

test('a configured binary path reaches the auth check for claude', async () => {
  const calls: string[][] = []
  const testDeps = deps({
    run: async (argv: string[]) => {
      calls.push(argv)
      return { stdout: '{"loggedIn":true}', exitCode: 0 }
    },
  })
  const a = await detectAuthWith(testDeps, 'claude', '/custom/path/claude')
  expect(calls[0]?.[0]).toBe('/custom/path/claude')
  expect(a.authed).toBe(true)
})

test('a configured binary path reaches the auth check for codex', async () => {
  const calls: string[][] = []
  const testDeps = deps({
    run: async (argv: string[]) => {
      calls.push(argv)
      return { stdout: 'Logged in using ChatGPT', exitCode: 0 }
    },
  })
  const a = await detectAuthWith(testDeps, 'codex', '/custom/path/codex')
  expect(calls[0]?.[0]).toBe('/custom/path/codex')
  expect(a.authed).toBe(true)
})

test('a configured binary path reaches the auth check for opencode', async () => {
  const calls: string[][] = []
  const testDeps = deps({
    run: async (argv: string[]) => {
      calls.push(argv)
      return { stdout: 'anthropic\n', exitCode: 0 }
    },
  })
  const a = await detectAuthWith(testDeps, 'opencode', '/custom/path/opencode')
  expect(calls[0]?.[0]).toBe('/custom/path/opencode')
  expect(a.authed).toBe(true)
})


// tests/fixtures/codex-models-cache.json is a slice of the real ~/.codex/models_cache.json
// (codex 0.155.1, 2026-09-21): only slug, default_reasoning_level and supported_reasoning_levels
// per model. The test this replaced faked the file as `{ id, supported_reasoning_levels: [string] }`
// — the real file has no `id` (the key is `slug`) and each level is `{ effort, description }`. The
// lookup therefore never matched on a real machine and codex effort was never clamped.
test('codex effort capabilities come from the model cache, keyed by slug, levels by their effort field', async () => {
  const cache = await Bun.file('tests/fixtures/codex-models-cache.json').text()
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async (p: string) => (p.endsWith('models_cache.json') ? cache : null),
    }),
    'codex',
    { model: 'gpt-6-astra' },
  )
  expect(d.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
})

test('a level entry that is not an object carrying an effort string is skipped', async () => {
  const cache = JSON.stringify({
    models: [{ slug: 'm', supported_reasoning_levels: [{ effort: 'low', description: 'x' }, 'high', { nope: 1 }] }],
  })
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async () => cache,
    }),
    'codex',
    { model: 'm' },
  )
  expect(d.efforts).toEqual(['low'])
})

test('a model cache whose shape is not what we captured yields no capabilities', async () => {
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async () => JSON.stringify({ models: { id: 'gpt-6-astra' } }),
    }),
    'codex',
    { model: 'gpt-6-astra' },
  )
  expect(d.efforts).toBeUndefined()
})

test('a supported-level field that is not a list is rejected', async () => {
  const d = await detectWith(
    deps({
      run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }),
      readText: async () => JSON.stringify({ models: [{ slug: 'm', supported_reasoning_levels: 'low,high' }] }),
    }),
    'codex',
    { model: 'm' },
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
    { model: 'nope' },
  )
  expect(d.efforts).toBeUndefined()
})

test('the right model is found among several in the cache', async () => {
  const cache = JSON.stringify({
    models: [
      { slug: 'other', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'max' }] },
    ],
  })
  const d = await detectWith(
    deps({ run: async () => ({ stdout: 'codex-cli 0.155.1', exitCode: 0 }), readText: async () => cache }),
    'codex',
    { model: 'gpt-6-astra' },
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

test('a json status becomes a sentence, not a brace', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}', exitCode: 0 }) }),
    'claude',
  )
  expect(a.detail).toBe('logged in via claude.ai')
})

test('a json status without a method still reads as a sentence', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{"loggedIn":false}', exitCode: 0 }) }),
    'claude',
  )
  expect(a.detail).toBe('not logged in')
})

test('json we cannot parse falls back to the first line', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{ this is not json\nsecond line', exitCode: 0 }) }),
    'claude',
  )
  expect(a.detail).toBe('{ this is not json')
})

test('a missing binary is unknown even if it somehow printed a verdict', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '{"loggedIn":true}', exitCode: 127 }) }),
    'claude',
  )
  expect(a.authed).toBe(null)
  expect(a.detail).toBe('not installed')
})

test('control bytes in the cli auth detail are stripped before konvoy stores or prints it', async () => {
  const a = await detectAuthWith(
    deps({ run: async () => ({ stdout: '\x1b]0;pwned\x07Logged in with IAM Identity Center', exitCode: 0 }) }),
    'kiro',
  )
  expect(a.detail).toBe('Logged in with IAM Identity Center')
  expect(a.detail).not.toContain('\x1b')
  expect(a.detail).not.toContain('\x07')
})

test('control bytes in a json auth method are stripped too', async () => {
  const a = await detectAuthWith(
    // \u001b here is a JSON string escape, so JSON.parse hands authMethod an actual ESC byte
    deps({ run: async () => ({ stdout: '{"loggedIn":true,"authMethod":"claude.ai\\u001b[31m"}', exitCode: 0 }) }),
    'claude',
  )
  expect(a.detail).toBe('logged in via claude.ai')
  expect(a.detail).not.toContain('\x1b')
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
  await expect(detect('codex', { deps: testDeps })).rejects.toThrow()
  const second = await detect('codex', { deps: testDeps })
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
  await expect(detectAuth('claude', { deps: testDeps })).rejects.toThrow()
  const second = await detectAuth('claude', { deps: testDeps })
  expect(second.authed).toBe(true)
})
