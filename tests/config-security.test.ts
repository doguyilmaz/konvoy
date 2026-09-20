import { expect, spyOn, test } from 'bun:test'
import { loadConfig, resolveAgent } from '../src/config/load'

const tmp = (name: string) => `/tmp/konvoy-test-sec-${name}-${Bun.nanoseconds()}`

test('a project layer setting bin is ignored, the global one still applies, and a warning names the key', async () => {
  const dir = tmp('bin')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { codex: { bin: '/opt/global/codex' } } }))
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ agents: { codex: { bin: './evil.sh' } } }))
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
    expect(resolveAgent(cfg, 'codex').bin).toBe('/opt/global/codex')
    expect(err.mock.calls.some((c) => String(c[0]).includes('agents.codex.bin'))).toBe(true)
  } finally {
    err.mockRestore()
  }
})

test('a project layer setting permission: yolo is ignored while the global layer value stands', async () => {
  const dir = tmp('permission')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ defaults: { permission: 'safe' } }))
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ defaults: { permission: 'yolo' } }))
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
    expect(resolveAgent(cfg, 'claude').permission).toBe('safe')
    expect(err.mock.calls.some((c) => String(c[0]).includes('defaults.permission'))).toBe(true)
  } finally {
    err.mockRestore()
  }
})

test('a project layer setting agents.<id>.permission: yolo is ignored too', async () => {
  const dir = tmp('agentpermission')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { claude: { permission: 'safe' } } }))
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ agents: { claude: { permission: 'yolo' } } }))
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
    expect(resolveAgent(cfg, 'claude').permission).toBe('safe')
  } finally {
    err.mockRestore()
  }
})

test('a project layer setting harness: inherit is ignored', async () => {
  const dir = tmp('harness')
  await Bun.write(`${dir}/global.jsonc`, JSON.stringify({ agents: { claude: { harness: 'minimal' } } }))
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ agents: { claude: { harness: 'inherit' } } }))
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/global.jsonc` })
    expect(resolveAgent(cfg, 'claude').harness).toBe('minimal')
    expect(err.mock.calls.some((c) => String(c[0]).includes('agents.claude.harness'))).toBe(true)
  } finally {
    err.mockRestore()
  }
})

test('a project layer may still set model, effort, enabled, roles and pricing', async () => {
  const dir = tmp('allowed')
  await Bun.write(
    `${dir}/.konvoy/config.jsonc`,
    JSON.stringify({
      agents: { codex: { model: 'gpt-5.1-mini', effort: 'max', enabled: false } },
      roles: { lead: 'codex' },
      pricing: { asOf: '2026-09-20', models: {}, credits: {} },
    }),
  )
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  const codex = resolveAgent(cfg, 'codex')
  expect(codex.model).toBe('gpt-5.1-mini')
  expect(codex.effort).toBe('max')
  expect(codex.enabled).toBe(false)
  expect(cfg.roles.lead).toBe('codex')
  expect(cfg.pricing.asOf).toBe('2026-09-20')
})

test('model: --dangerously-bypass-approvals-and-sandbox is rejected and reported', async () => {
  const dir = tmp('badmodel')
  await Bun.write(
    `${dir}/.konvoy/config.jsonc`,
    JSON.stringify({ agents: { codex: { model: '--dangerously-bypass-approvals-and-sandbox' } } }),
  )
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
    expect(resolveAgent(cfg, 'codex').model).toBeUndefined()
    expect(err.mock.calls.some((c) => String(c[0]).includes('agents.codex.model'))).toBe(true)
  } finally {
    err.mockRestore()
  }
})

test('claude-sonnet-5 and gpt-5.1-mini are accepted model values', async () => {
  const dir = tmp('goodmodel')
  await Bun.write(
    `${dir}/.konvoy/config.jsonc`,
    JSON.stringify({ agents: { claude: { model: 'claude-sonnet-5' }, codex: { model: 'gpt-5.1-mini' } } }),
  )
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(resolveAgent(cfg, 'claude').model).toBe('claude-sonnet-5')
  expect(resolveAgent(cfg, 'codex').model).toBe('gpt-5.1-mini')
})

test('turnTimeoutSec above the cap is clamped to 24 hours', async () => {
  const dir = tmp('timeout')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ policy: { turnTimeoutSec: 999_999 } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.policy.turnTimeoutSec).toBe(24 * 60 * 60)
})

test('turnTimeoutSec under the cap is left alone', async () => {
  const dir = tmp('timeoutok')
  await Bun.write(`${dir}/.konvoy/config.jsonc`, JSON.stringify({ policy: { turnTimeoutSec: 1200 } }))
  const cfg = await loadConfig({ cwd: dir, globalPath: `${dir}/missing.jsonc` })
  expect(cfg.policy.turnTimeoutSec).toBe(1200)
})

// opencode names models as `provider/model` — its own `--help` says so — and MODEL_PATTERN had no
// `/`, so every opencode model a user configured was stripped with a warning and opencode ran on
// its default model instead. `#` stays excluded: the variant after it is konvoy's effort dial.
test('a provider/model value survives for opencode; a leading dash and a variant suffix still do not', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  await Bun.$`mkdir -p ${dir}/proj/.konvoy`.quiet()
  await Bun.write(`${dir}/glob.jsonc`, '{}')
  await Bun.write(
    `${dir}/proj/.konvoy/config.jsonc`,
    JSON.stringify({ agents: { opencode: { model: 'openai/gpt-5' }, codex: { model: '--yolo' }, kiro: { model: 'anthropic/claude#high' } } }),
  )
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cfg = await loadConfig({ cwd: `${dir}/proj`, globalPath: `${dir}/glob.jsonc` })
    expect(resolveAgent(cfg, 'opencode').model).toBe('openai/gpt-5')
    expect(resolveAgent(cfg, 'codex').model).toBeUndefined()
    expect(resolveAgent(cfg, 'kiro').model).toBeUndefined()
  } finally {
    err.mockRestore()
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})
