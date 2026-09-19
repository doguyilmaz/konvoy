import { expect, test } from 'bun:test'
import { loadConfig, resolveAgent, explain } from '../src/config/load'

const tmp = (name: string) => `/tmp/konvoy-test-${name}-${Bun.nanoseconds()}`

test('the harness profile defaults to minimal and is overridable per agent', async () => {
  const dir = tmp('harness')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ agents: { claude: { harness: 'inherit' } } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(resolveAgent(cfg, 'claude').harness).toBe('inherit')
  expect(resolveAgent(cfg, 'codex').harness).toBe('minimal')
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

test('an unknown key is rejected with its path', async () => {
  const dir = tmp('bad')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ agents: { codex: { efort: 'max' } } }))
  expect(loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })).rejects.toThrow(/agents\.codex\.efort/)
})

test('comments and trailing commas are tolerated', async () => {
  const dir = tmp('jsonc')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, '{\n  // lead is claude\n  "roles": { "lead": "claude" },\n}')
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.roles.lead).toBe('claude')
})
