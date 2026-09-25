import { expect, spyOn, test } from 'bun:test'
import { configSchema, type Config } from '../src/config/schema'
import { acceptedButUnusedKeys, cmdDoctor, distinctPaths } from '../src/commands/doctor'
import { clearDetectCache, type DetectDeps } from '../src/core/detect'

function cfg(over: Record<string, unknown>): Config {
  return configSchema.parse(over)
}

// Doctor is driven entirely through its deps seam, so a test can never prime a cache entry under
// one key while doctor looks under another. The bins stay unique per test anyway: the memo key is
// (agent, model, bin), and a shared bin would let another test file's real detection answer ours.
function fakeDeps(byBin: Record<string, { version?: string; auth?: string; exitCode?: number }>): DetectDeps {
  return {
    run: async (cmd: string[]) => {
      const entry = byBin[cmd[0] ?? '']
      if (!entry) return { stdout: '', exitCode: 127 }
      if (cmd[1] === '--version') {
        return entry.version === undefined
          ? { stdout: '', exitCode: 127 }
          : { stdout: entry.version, exitCode: 0 }
      }
      return { stdout: entry.auth ?? '', exitCode: entry.exitCode ?? 0 }
    },
    readText: async () => null,
  }
}

async function runDoctor(config: Config, deps: DetectDeps): Promise<{ lines: string[]; code: number }> {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const code = await cmdDoctor(config, deps)
    return { lines: log.mock.calls.map((c) => String(c[0])), code }
  } finally {
    log.mockRestore()
    clearDetectCache()
  }
}

test('a role naming a disabled agent fails doctor', async () => {
  const bin = 'doctor-test-lead-b'
  const { lines, code } = await runDoctor(
    cfg({
      agents: {
        claude: { bin },
        codex: { enabled: false },
        kiro: { enabled: false },
        opencode: { enabled: false },
      },
      roles: { reviewer: 'codex' },
    }),
    fakeDeps({ [bin]: { version: '2.1.278', auth: '{"loggedIn":true}' } }),
  )
  expect(lines).toContain('\u2717  codex: disabled in config but named by a role')
  expect(code).toBe(1)
})

test('an agent that fails auth is reported once, not also as ok', async () => {
  const bin = 'doctor-test-lead-c'
  const { lines } = await runDoctor(
    cfg({
      agents: {
        claude: { bin },
        codex: { enabled: false },
        kiro: { enabled: false },
        opencode: { enabled: false },
      },
    }),
    fakeDeps({ [bin]: { version: '2.1.278', auth: '{"loggedIn":false}' } }),
  )
  expect(lines.some((l) => l.startsWith('\u2717  claude:'))).toBe(true)
  expect(lines.some((l) => l.startsWith('\u2713  claude:'))).toBe(false)
})

test('an uninstalled agent that no role names is reported, not failed', async () => {
  const leadBin = 'doctor-test-lead-d'
  const missingBin = 'doctor-test-missing-d'
  const { lines, code } = await runDoctor(
    cfg({
      agents: {
        claude: { bin: leadBin },
        codex: { enabled: false },
        kiro: { enabled: false },
        opencode: { bin: missingBin, model: 'x' },
      },
    }),
    fakeDeps({ [leadBin]: { version: '2.1.278', auth: '{"loggedIn":true}' } }),
  )
  expect(lines).toContain('\u00b7  opencode: not installed - konvoy install opencode')
  expect(lines).not.toContain('x opencode: not installed')
  expect(code).toBe(0)
})

test('a logged-out agent that no role names is reported, not failed', async () => {
  const leadBin = 'doctor-test-lead-e'
  const outBin = 'doctor-test-loggedout-e'
  const { lines, code } = await runDoctor(
    cfg({
      agents: {
        claude: { bin: leadBin },
        codex: { enabled: false },
        kiro: { enabled: false },
        opencode: { bin: outBin, model: 'x' },
      },
    }),
    fakeDeps({
      [leadBin]: { version: '2.1.278', auth: '{"loggedIn":true}' },
      [outBin]: { version: 'opencode 2.0.10', auth: '' },
    }),
  )
  expect(lines.some((l) => l.startsWith('\u00b7  opencode:'))).toBe(true)
  expect(lines.some((l) => l.startsWith('\u2717  opencode:'))).toBe(false)
  expect(code).toBe(0)
})

test('engine and delegation-policy keys the user set are named as accepted but unused', () => {
  const cfg = configSchema.parse({
    agents: { codex: { engine: 'v3' } },
    policy: { isolation: 'parallel' },
  })
  expect(acceptedButUnusedKeys(cfg)).toEqual(['policy.isolation', 'agents.codex.engine'])
})

test('an untouched config names no accepted-but-unused keys', () => {
  const cfg = configSchema.parse({})
  expect(acceptedButUnusedKeys(cfg)).toEqual([])
})

test('a PATH directory listed twice is not reported as a shadowing binary', () => {
  // `which -a` prints one line per PATH entry, so a duplicated entry repeats the same path
  expect(distinctPaths('/usr/local/bin/codex\n/usr/local/bin/codex\n')).toEqual(['/usr/local/bin/codex'])
  expect(distinctPaths('/a/claude\n/a/claude\n/b/claude\n')).toEqual(['/a/claude', '/b/claude'])
  expect(distinctPaths('  \n')).toEqual([])
})

// doctor reported with four glyph styles at once - `ok `, `x `, `- `, `! ` and `i ` - unaligned,
// uncoloured, and with the agent name buried mid-sentence, while every table beside it now lines
// its columns up. One glyph set, one column, and a line that names its agent first.
test('every doctor line uses one glyph set and starts with the agent it is about', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let lines: string[]
  try {
    await cmdDoctor(cfg({}), fakeDeps({}))
    lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.trim() !== '')
  } finally {
    log.mockRestore()
  }

  const report = lines.filter((l) => !l.includes('problem'))
  expect(report.length).toBeGreaterThan(0)
  for (const line of report) {
    // one of the four glyphs, then the agent, then the finding
    expect(line, line).toMatch(/^[✓✗!·] {1,2}\S/u)
    expect(line, line).not.toMatch(/^(ok|x|-|!|i) /)
  }
})
