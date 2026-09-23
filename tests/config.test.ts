import { expect, spyOn, test } from 'bun:test'
import { loadConfig, resolveAgent, explain } from '../src/config/load'
import { agentIds } from '../src/config/schema'

const tmp = (name: string) => `/tmp/konvoy-test-${name}-${Bun.nanoseconds()}`

test('a harness pinned per agent in the global config beats the driver default', async () => {
  const dir = tmp('harness')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { claude: { harness: 'inherit' } } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  expect(resolveAgent(cfg, 'claude').harness).toBe('inherit')
  // unset for everyone else, so effectiveHarness() decides from who drove the turn - see
  // tests/harness.test.ts. A default here would have taken that decision away from the caller.
  expect(resolveAgent(cfg, 'codex').harness).toBeUndefined()
})

test('an empty setup yields built-in defaults', async () => {
  const dir = tmp('empty')
  await Bun.write(`${dir}/marker`, '')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  const claude = resolveAgent(cfg, 'claude')
  expect(claude.effort).toBe('high')
  expect(claude.permission).toBe('edit')
  expect(claude.enabled).toBe(true)
})

test('the project config overrides the global config', async () => {
  const dir = tmp('layered')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ defaults: { effort: 'low' } }))
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ defaults: { effort: 'max' } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  expect(resolveAgent(cfg, 'codex').effort).toBe('max')
})

test('a per-agent value beats the defaults block', async () => {
  const dir = tmp('peragent')
  await Bun.write(
    `${dir}/.konvoy/config.jsonc`,
    JSON.stringify({ defaults: { effort: 'low' }, agents: { codex: { effort: 'max' } } }),
  )
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(resolveAgent(cfg, 'codex').effort).toBe('max')
  expect(resolveAgent(cfg, 'kiro').effort).toBe('low')
  expect(explain(cfg, 'codex', 'effort').source).toBe('agent')
  expect(explain(cfg, 'kiro', 'effort').source).toBe('defaults')
})

// These four assert the schema's strictness through the global layer - the user's own file, where
// a mistake stays fatal. The same inputs in a project file are reported and set aside instead
// (config-security.test.ts), because a cloned repository's mistake must not stop konvoy.
test('an unknown key is rejected with its path', async () => {
  const dir = tmp('bad')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { codex: { efort: 'max' } } }))
  expect(loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })).rejects.toThrow(/agents\.codex\.efort/)
})

test('comments and trailing commas are tolerated', async () => {
  const dir = tmp('jsonc')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{\n  // lead is claude\n  "roles": { "lead": "claude" },\n}')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.roles.lead).toBe('claude')
})

test('an invalid enum value in defaults is rejected', async () => {
  const dir = tmp('badenum')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ defaults: { effort: 'turbo' } }))
  expect(loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })).rejects.toThrow(/defaults\.effort/)
})

test('an invalid key inside defaults is rejected with its path', async () => {
  const dir = tmp('baddefault')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ defaults: { efrot: 'high' } }))
  expect(loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })).rejects.toThrow(/defaults\.efrot/)
})

test('JSONC with double-slash inside a string is preserved', async () => {
  const dir = tmp('urlstring')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { codex: { bin: '/usr/local/bin//codex' } } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  expect(cfg.agents.codex?.bin).toBe('/usr/local/bin//codex')
})

test('JSONC with trailing comma inside a string is preserved', async () => {
  const dir = tmp('commastring')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{"pricing":{"asOf":"value,}"}}')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.pricing.asOf).toBe('value,}')
})

test('__proto__ key is rejected as an unknown key', async () => {
  const dir = tmp('proto')
  await Bun.write(`${dir}/global.jsonc`, '{"__proto__": {"polluted": true}}')
  expect(loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })).rejects.toThrow(/__proto__/)
})

test('JSONC: trailing comma followed by line comment', async () => {
  const dir = tmp('trailinglinecomment')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{\n  "defaults": {}, // trailing\n}')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.defaults.effort).toBe('high')
})

test('JSONC: trailing comma followed by block comment', async () => {
  const dir = tmp('trailingblockcomment')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{"defaults": {}, /* trailing */ }')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.defaults.effort).toBe('high')
})

test('JSONC: array with trailing comma and comment', async () => {
  const dir = tmp('arraytrailingcomment')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{"roles": {"lead": "claude", // trailing\n}}')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.roles.lead).toBe('claude')
})

test('JSONC: escaped quote in string with double-slash after', async () => {
  const dir = tmp('escapedquote')
  await Bun.write(`${dir}/global.jsonc`, '{"agents":{"codex":{"bin":"a\\"b//c"}}}')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  expect(cfg.agents.codex?.bin).toBe('a"b//c')
})

// bin is privileged (config/load.ts strips it from the project layer), so these set it
// on the global layer the same way tests/config-security.test.ts does
test('a leading ~/ in a configured bin resolves to the home directory', async () => {
  const dir = tmp('tilde')
  const home = tmp('tilde-home')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { opencode: { bin: '~/.opencode/bin/opencode' } } }))
  const prevHome = Bun.env.HOME
  Bun.env.HOME = home
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
    expect(resolveAgent(cfg, 'opencode').bin).toBe(`${home}/.opencode/bin/opencode`)
  } finally {
    if (prevHome === undefined) delete Bun.env.HOME
    else Bun.env.HOME = prevHome
  }
})

test('a bare ~ resolves to the home directory itself', async () => {
  const dir = tmp('bareTilde')
  const home = tmp('bareTilde-home')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { opencode: { bin: '~' } } }))
  const prevHome = Bun.env.HOME
  Bun.env.HOME = home
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
    expect(resolveAgent(cfg, 'opencode').bin).toBe(home)
  } finally {
    if (prevHome === undefined) delete Bun.env.HOME
    else Bun.env.HOME = prevHome
  }
})

test('an absolute bin path is left untouched', async () => {
  const dir = tmp('absBin')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { opencode: { bin: '/abs/x' } } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  expect(resolveAgent(cfg, 'opencode').bin).toBe('/abs/x')
})

test('a non-leading tilde in a bin path is left untouched', async () => {
  const dir = tmp('relTilde')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { opencode: { bin: 'rel/~/x' } } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  expect(resolveAgent(cfg, 'opencode').bin).toBe('rel/~/x')
})

test('a malformed project config names the file, not a raw SyntaxError', async () => {
  const dir = tmp('malformed')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{ "defaults": { "effort": }')
  await expect(loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })).rejects.toThrow(
    new RegExp(`${dir}/\\.konvoy/config\\.jsonc`),
  )
  try {
    await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
    throw new Error('expected loadConfig to reject')
  } catch (e) {
    expect((e as Error).message).not.toContain('SyntaxError')
    expect((e as Error).name).not.toBe('SyntaxError')
  }
})

// `config get` printed `claude: model=- effort=high (defaults) permission=edit enabled=true`, a
// key=value run-on and the last unaligned multi-agent output in the tool. It is the same shape as
// a roster - one row per agent - so it goes through the same table, with the source of each
// resolved value in its own column instead of in parentheses mid-line.
test('config get prints one aligned row per agent, with where each value came from', async () => {
  const dir = tmp('get-table')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ defaults: { effort: 'medium' }, agents: { kiro: { model: 'auto' } } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
  const { cmdConfig } = await import('../src/commands/config')
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    expect(await cmdConfig(cfg, dir, 'get')).toBe(0)
    lines = log.mock.calls.map((c) => String(c[0])).join('\n').trim().split('\n')
  } finally {
    log.mockRestore()
  }

  expect(lines[0]).toContain('AGENT')
  expect(lines[0]).toContain('MODEL')
  expect(lines[0]).toContain('EFFORT')
  expect(lines[0]).toContain('PERMISSION')
  expect(lines).toHaveLength(agentIds.length + 1)

  // one column per value, so the rows line up and the source is readable
  for (const line of lines.slice(1)) expect(line).not.toContain('=')
  const kiro = lines.find((l) => l.startsWith('kiro'))!
  expect(kiro).toContain('auto')
  expect(kiro).toContain('medium')
})
