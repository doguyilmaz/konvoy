import { expect, spyOn, test } from 'bun:test'
import { channelOf, installPlan, kegOf, PACKAGING, resolveLinks, updatePlan, type Origin } from '../src/core/install'
import { cmdInstall, type InstallDeps } from '../src/commands/install'
import { cmdUpdate } from '../src/commands/update'
import { agentIds, configSchema } from '../src/config/schema'
import type { AgentId } from '../src/types'

const cfg = configSchema.parse({})

// Homebrew links /opt/homebrew/bin into its Cellar or Caskroom, npm links its bin into
// node_modules, bun keeps its globals under ~/.bun, and a vendor script writes where only it does.
test('the channel that installed a binary is read from its path and the file it resolves to', () => {
  const home = '/Users/me'
  expect(channelOf('codex', '/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.156.1/codex', home)).toBe('brew')
  expect(channelOf('codex', '/usr/local/bin/codex', '/usr/local/Cellar/codex/0.156.1/bin/codex', home)).toBe('brew')
  expect(channelOf('codex', '/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', home)).toBe('npm')
  expect(channelOf('opencode', `${home}/.bun/bin/opencode`, `${home}/.bun/install/global/node_modules/opencode-ai/bin/opencode`, home)).toBe('bun')
  expect(channelOf('opencode', `${home}/.opencode/bin/opencode`, `${home}/.opencode/bin/opencode`, home)).toBe('script')
  expect(channelOf('claude', `${home}/.local/bin/claude`, `${home}/.local/share/claude/versions/2.1.282`, home)).toBe('script')
  expect(channelOf('codex', `${home}/.local/bin/codex`, `${home}/.codex/packages/standalone/releases/0.160.0/bin/codex`, home)).toBe('script')
  expect(channelOf('antigravity', `${home}/.local/bin/agy`, `${home}/.local/bin/agy`, home)).toBe('script')
  // a distribution's package: apt, dnf, pacman, nix
  expect(channelOf('claude', '/usr/bin/claude', '/usr/bin/claude', home)).toBe('system')
  expect(channelOf('kiro', '/usr/bin/kiro-cli', '/usr/lib/kiro-cli/kiro-cli', home)).toBe('system')
  expect(channelOf('opencode', `${home}/.nix-profile/bin/opencode`, '/nix/store/abc-opencode-1.2.0/bin/opencode', home)).toBe('system')
  // npm with a /usr prefix is still npm, and a hand-placed binary is nobody's
  expect(channelOf('codex', '/usr/bin/codex', '/usr/lib/node_modules/@openai/codex/bin/codex.js', home)).toBe('npm')
  expect(channelOf('claude', '/usr/local/bin/claude', '/usr/local/bin/claude', home)).toBe('unknown')
  expect(channelOf('claude', '/opt/claude-code/bin/claude', '/opt/claude-code/bin/claude', home)).toBe('unknown')
})

test('a Homebrew path names the formula or cask it sits in', () => {
  expect(kegOf('/opt/homebrew/Caskroom/claude-code@latest/2.1.282/claude')).toEqual({ name: 'claude-code@latest', cask: true })
  expect(kegOf('/usr/local/Cellar/opencode/1.2.0/bin/opencode')).toEqual({ name: 'opencode', cask: false })
  expect(kegOf('/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli')).toBeNull()
})

test('a chain of symlinks is followed to its end, relative targets resolved against their link', () => {
  const links: Record<string, string> = {
    '/usr/local/bin/codex': '../lib/node_modules/@openai/codex/bin/codex.js',
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js': 'real.js',
  }
  expect(resolveLinks('/usr/local/bin/codex', (p) => links[p] ?? null)).toBe('/usr/local/lib/node_modules/@openai/codex/bin/real.js')
  expect(resolveLinks('/bin/plain', () => null)).toBe('/bin/plain')
})

// A self-updater replacing files a package manager owns leaves the manager out of step, and some
// refuse outright: the channel that installed a binary is the one that updates it.
const argv = (agent: AgentId, origin: Origin | Origin['channel'], bin: string) => {
  const plan = updatePlan(agent, origin, bin)
  return 'argv' in plan ? plan.argv : plan.reason
}

test('an update goes through the channel that installed the binary', () => {
  expect(argv('codex', 'brew', 'codex')).toEqual(['brew', 'upgrade', '--cask', 'codex'])
  expect(argv('codex', 'npm', 'codex')).toEqual(['npm', 'install', '-g', '@openai/codex@latest'])
  expect(argv('opencode', 'bun', 'opencode')).toEqual(['bun', 'add', '-g', 'opencode-ai@latest'])
  expect(argv('claude', 'script', '/x/claude')).toEqual(['/x/claude', 'update'])
  expect(argv('opencode', 'unknown', 'opencode')).toEqual(['opencode', 'upgrade'])
  // no npm package of its own: a bun or npm path is not a reason to guess one
  expect(argv('kiro', 'npm', 'kiro-cli')).toEqual(['kiro-cli', 'update'])
})

test('Homebrew upgrades the keg the binary is in, and leaves a community cask to the CLI', () => {
  expect(argv('claude', { channel: 'brew', keg: { name: 'claude-code@latest', cask: true } }, 'claude')).toEqual(['brew', 'upgrade', '--cask', 'claude-code@latest'])
  // homebrew-core's formula or the vendor tap's: brew resolves the kept name to whichever is installed
  expect(argv('opencode', { channel: 'brew', keg: { name: 'opencode', cask: false } }, 'opencode')).toEqual(['brew', 'upgrade', 'opencode'])
  expect(argv('opencode', 'brew', 'opencode')).toEqual(['brew', 'upgrade', 'anomalyco/tap/opencode'])
  // kiro-cli and antigravity-cli casks are not the vendors' and are marked auto_updates
  expect(argv('kiro', { channel: 'brew', keg: null }, 'kiro-cli')).toEqual(['kiro-cli', 'update'])
  expect(argv('antigravity', { channel: 'brew', keg: { name: 'antigravity-cli', cask: true } }, 'agy')).toEqual(['agy', 'update'])
  // and a keg under another name is not taken for this CLI's
  expect(argv('opencode', { channel: 'brew', keg: { name: 'opencode-desktop', cask: true } }, 'opencode')).toEqual(['opencode', 'upgrade'])
})

test('a distribution package is left to the distribution', () => {
  expect(argv('claude', 'system', '/usr/bin/claude')).toBe("/usr/bin/claude belongs to the system's package manager, which is what updates it")
})

test('every agent has somewhere documented to install from and a way to update', () => {
  for (const agent of agentIds) {
    const p = PACKAGING[agent]
    expect(p.docs, agent).toStartWith('https://')
    expect(p.install.length, `${agent} has no documented install`).toBeGreaterThan(0)
    expect('argv' in updatePlan(agent, 'unknown', agent), agent).toBe(true)
    expect(p.binPaths?.length, `${agent} has nowhere to look when its install lands off PATH`).toBeGreaterThan(0)
    // a script recipe fails when its download does, instead of piping an empty page to a shell
    for (const r of p.install.filter((r) => r.via === 'script')) {
      expect(r.command, agent).toMatch(/^curl -fsSL https:\/\/\S+ \| (?:[A-Z_]+=\S+ )*(ba)?sh$/)
      expect(r.argv, agent).toEqual(['bash', '-c', `set -o pipefail; ${r.command}`])
    }
  }
})

test('the first documented install whose tools are here is chosen, or the one named with --via', () => {
  const only = (tools: string[]) => (t: string) => tools.includes(t)
  const scriptFirst = installPlan('claude', { has: only(['curl', 'bash', 'npm']) })
  expect('plan' in scriptFirst && scriptFirst.recipe.via).toBe('script')
  const noCurl = installPlan('claude', { has: only(['npm']) })
  expect('plan' in noCurl && noCurl.plan.argv).toEqual(['npm', 'install', '-g', '@anthropic-ai/claude-code'])
  const named = installPlan('claude', { via: 'npm', has: only(['curl', 'bash', 'npm']) })
  expect('plan' in named && named.recipe.via).toBe('npm')
  const nothing = installPlan('claude', { has: only([]) })
  expect('reason' in nothing && nothing.reason).toContain('needs')
  const notThatWay = installPlan('kiro', { via: 'npm', has: only(['npm']) })
  expect('reason' in notThatWay && notThatWay.reason).toBe('kiro is not installed with npm; its documented ways are script')
  // codex's installer would otherwise stop to ask whether to start codex
  const codex = installPlan('codex', { has: only(['curl', 'bash']) })
  expect('plan' in codex && codex.plan.command).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh')
})

function deps(over: Partial<InstallDeps> & { installed?: AgentId[] } = {}) {
  const ran: string[][] = []
  const installed = new Set(over.installed ?? [])
  const d: InstallDeps = {
    detect: async (agent) => ({ agent, installed: installed.has(agent), version: installed.has(agent) ? '1.0.0' : null }),
    spawn: async (argv) => {
      ran.push([...argv])
      return 0
    },
    has: () => true,
    confirm: () => true,
    exists: async () => false,
    ...over,
  }
  return { d, ran }
}

function logs(): { lines: () => string[]; restore: () => void } {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  return { lines: () => log.mock.calls.map((c) => String(c[0])), restore: () => log.mockRestore() }
}

test('install shows the command and its source, and runs it only on a yes', async () => {
  const out = logs()
  try {
    const yes = deps()
    expect(await cmdInstall(cfg, { agents: ['claude'], all: false, yes: false, dryRun: false }, yes.d)).toBe(1)
    expect(yes.ran).toEqual([['bash', '-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']])
    expect(out.lines()).toContain('installing claude, the vendor\'s script install: curl -fsSL https://claude.ai/install.sh | bash')
    expect(out.lines().some((l) => l.includes(PACKAGING.claude.docs))).toBe(true)

    const no = deps({ confirm: () => false })
    await cmdInstall(cfg, { agents: ['claude'], all: false, yes: false, dryRun: false }, no.d)
    expect(no.ran).toEqual([])

    // no terminal to ask at: nothing runs unless --yes says it was read
    const piped = deps({ confirm: () => null })
    expect(await cmdInstall(cfg, { agents: ['claude'], all: false, yes: false, dryRun: false }, piped.d)).toBe(1)
    expect(piped.ran).toEqual([])
    const forced = deps({ confirm: () => null })
    await cmdInstall(cfg, { agents: ['claude'], all: false, yes: true, dryRun: false }, forced.d)
    expect(forced.ran).toHaveLength(1)
  } finally {
    out.restore()
  }
})

test('--dry-run says what would run and runs nothing; an installed agent is left alone', async () => {
  const out = logs()
  try {
    const dry = deps({ installed: ['claude'] })
    expect(await cmdInstall(cfg, { agents: [], all: true, yes: true, dryRun: true }, dry.d)).toBe(0)
    expect(dry.ran).toEqual([])
    expect(out.lines()).toContain('- claude: already installed (1.0.0) - konvoy update claude to update it')
    expect(out.lines().filter((l) => l.startsWith('installing '))).toHaveLength(agentIds.length - 1)
  } finally {
    out.restore()
  }
})

test('an install that lands off PATH says where it went and how to point konvoy at it', async () => {
  const out = logs()
  try {
    const off = deps({ exists: async (p) => p.endsWith('/.opencode/bin/opencode') })
    expect(await cmdInstall(cfg, { agents: ['opencode'], all: false, yes: true, dryRun: false }, off.d)).toBe(1)
    const said = out.lines().join('\n')
    expect(said).toMatch(/opencode: installed to \S+\/\.opencode\/bin\/opencode, which is not on PATH/)
    expect(said).toContain('konvoy config set agents.opencode.bin')
  } finally {
    out.restore()
  }
})

test('install with nothing named lists every agent and what would install it', async () => {
  const out = logs()
  try {
    const d = deps({ installed: ['claude'] })
    expect(await cmdInstall(cfg, { agents: [], all: false, yes: false, dryRun: false }, d.d)).toBe(0)
    expect(d.ran).toEqual([])
    const rows = out.lines()[0]!.split('\n')
    expect(rows[0]).toMatch(/^AGENT\s+STATUS\s+INSTALL WITH/)
    expect(rows.find((r) => r.startsWith('claude'))).toMatch(/^claude\s+1\.0\.0$/)
    expect(rows.find((r) => r.startsWith('opencode'))).toContain('curl -fsSL')
  } finally {
    out.restore()
  }
})

test('an unknown --via or agent is refused before anything runs', async () => {
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await cmdInstall(cfg, { agents: ['claude'], all: false, via: 'pip', yes: true, dryRun: false }, deps().d)).toBe(2)
    expect(await cmdInstall(cfg, { agents: ['clod'], all: false, yes: true, dryRun: false }, deps().d)).toBe(2)
  } finally {
    err.mockRestore()
  }
})

test('update names agents one by one, follows each one channel, and updates konvoy last on --all', async () => {
  const out = logs()
  const ran: string[][] = []
  try {
    const code = await cmdUpdate(
      cfg,
      { all: false, agents: ['codex'] },
      {
        detect: async (agent) => ({ agent, installed: true, version: '0.1.0' }),
        spawn: async (argv) => (ran.push(argv), 0),
        origin: () => ({ channel: 'brew' }),
        self: () => ({ command: 'brew upgrade --cask konvoy', argv: ['brew', 'upgrade', '--cask', 'konvoy'], why: 'installed with Homebrew' }),
      },
    )
    expect(code).toBe(0)
    // one agent named, so konvoy itself is not touched
    expect(ran).toEqual([['brew', 'upgrade', '--cask', 'codex']])
    expect(out.lines()).toContain('updating codex (0.1.0), installed with Homebrew: brew upgrade --cask codex')

    ran.length = 0
    await cmdUpdate(
      configSchema.parse({ agents: { claude: { enabled: false }, kiro: { enabled: false }, opencode: { enabled: false }, antigravity: { enabled: false } } }),
      { all: true, dryRun: true },
      {
        detect: async (agent) => ({ agent, installed: true, version: '0.1.0' }),
        spawn: async (argv) => (ran.push(argv), 0),
        origin: () => ({ channel: 'npm' }),
        self: () => ({ command: 'bun add -g @doguyilmaz/konvoy@latest', argv: ['bun', 'add', '-g', '@doguyilmaz/konvoy@latest'], why: 'installed with bun' }),
      },
    )
    // --dry-run: the plan is printed, nothing runs
    expect(ran).toEqual([])
    expect(out.lines()).toContain('updating codex (0.1.0), installed with npm: npm install -g @openai/codex@latest')
    expect(out.lines()).toContain('updating konvoy, installed with bun: bun add -g @doguyilmaz/konvoy@latest')
  } finally {
    out.restore()
  }
})
