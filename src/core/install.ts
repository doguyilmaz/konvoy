import type { AgentId } from '../types'
import { dirname, home, join } from '../paths'

// How each agent CLI is installed and kept current, in its vendor's own words. konvoy runs these
// on request and never invents one: every command below is the one the vendor documents, and the
// source is linked beside it so a stale entry can be checked rather than trusted.

/**
 * how a binary came to be where it is, read from its path. `system` is a distribution's package
 * manager (apt, dnf, pacman, nix, snap), which owns the file and is the only thing that should
 * replace it.
 */
export type Channel = 'brew' | 'npm' | 'bun' | 'script' | 'system' | 'unknown'

export interface Recipe {
  via: 'script' | 'npm' | 'brew' | 'bun'
  /** the command as the vendor documents it, shown before anything runs */
  command: string
  argv: readonly string[]
  /** what must be on PATH for it to run at all */
  needs: readonly string[]
}

export interface Packaging {
  /** where the vendor documents installing it */
  docs: string
  /** in the vendor's order of preference */
  install: readonly Recipe[]
  npm?: string
  brew?: Keg
  /** the CLI's own updater: the arguments after its binary */
  self?: readonly string[]
  /** path fragments only its own installer produces, so a script install is told apart */
  scriptPaths?: readonly string[]
  /** where its installers put the binary (~ is home), for when that is not on PATH */
  binPaths?: readonly string[]
}

/** a Homebrew formula or cask */
export interface Keg {
  name: string
  cask: boolean
}

// `set -o pipefail`: a curl that fails must fail the install, not hand the shell an empty script
const script = (url: string, shell: 'bash' | 'sh' = 'bash', env = ''): Recipe => {
  const command = `curl -fsSL ${url} | ${env === '' ? '' : `${env} `}${shell}`
  return { via: 'script', command, argv: ['bash', '-c', `set -o pipefail; ${command}`], needs: ['curl', 'bash'] }
}
const npm = (pkg: string): Recipe => ({ via: 'npm', command: `npm install -g ${pkg}`, argv: ['npm', 'install', '-g', pkg], needs: ['npm'] })
const bun = (pkg: string): Recipe => ({ via: 'bun', command: `bun add -g ${pkg}`, argv: ['bun', 'add', '-g', pkg], needs: ['bun'] })
const brew = ({ name, cask }: Keg): Recipe => ({
  via: 'brew',
  command: `brew install ${cask ? '--cask ' : ''}${name}`,
  argv: ['brew', 'install', ...(cask ? ['--cask'] : []), name],
  needs: ['brew'],
})

const CLAUDE_BREW: Keg = { name: 'claude-code', cask: true }
const CODEX_BREW: Keg = { name: 'codex', cask: true }
// the vendor's own tap, which its README recommends over homebrew-core's `opencode` ("updated less")
const OPENCODE_BREW: Keg = { name: 'anomalyco/tap/opencode', cask: false }

// Checked 2026-09 against each vendor's install page, README and installer source. Homebrew has
// community casks for kiro-cli and antigravity-cli too, but neither vendor documents them (Kiro's
// page says Homebrew is not a supported install path), so konvoy does not offer them.
export const PACKAGING: Record<AgentId, Packaging> = {
  claude: {
    docs: 'https://code.claude.com/docs/en/setup',
    // npm last: the vendor marks it deprecated in favour of the native install
    install: [script('https://claude.ai/install.sh'), brew(CLAUDE_BREW), npm('@anthropic-ai/claude-code')],
    npm: '@anthropic-ai/claude-code',
    brew: CLAUDE_BREW,
    self: ['update'],
    // the native install links ~/.local/bin/claude into its versions; ~/.claude/local is the older local install
    scriptPaths: ['/.local/share/claude/', '/.claude/local/'],
    binPaths: ['~/.local/bin/claude'],
  },
  codex: {
    docs: 'https://github.com/openai/codex#installing-and-running-codex-cli',
    // the installer asks on /dev/tty, even when piped, whether to start codex once it is done;
    // CODEX_NON_INTERACTIVE=1 is how codex's own `update` runs it (codex-rs/tui/src/update_action.rs)
    install: [script('https://chatgpt.com/codex/install.sh', 'sh', 'CODEX_NON_INTERACTIVE=1'), npm('@openai/codex'), brew(CODEX_BREW)],
    npm: '@openai/codex',
    brew: CODEX_BREW,
    self: ['update'],
    scriptPaths: ['/.codex/packages/standalone/'],
    binPaths: ['~/.local/bin/codex'],
  },
  kiro: {
    docs: 'https://kiro.dev/docs/cli/installation/',
    install: [script('https://cli.kiro.dev/install')],
    self: ['update'],
    scriptPaths: ['/.local/bin/kiro-cli'],
    binPaths: ['~/.local/bin/kiro-cli'],
  },
  opencode: {
    docs: 'https://opencode.ai/docs/#install',
    install: [script('https://opencode.ai/install'), npm('opencode-ai'), brew(OPENCODE_BREW), bun('opencode-ai')],
    npm: 'opencode-ai',
    brew: OPENCODE_BREW,
    self: ['upgrade'],
    scriptPaths: ['/.opencode/bin/'],
    binPaths: ['~/.opencode/bin/opencode'],
  },
  antigravity: {
    docs: 'https://github.com/google-antigravity/antigravity-cli#installation',
    install: [script('https://antigravity.google/cli/install.sh')],
    self: ['update'],
    scriptPaths: ['/.local/bin/agy', '/.gemini/antigravity-cli/'],
    binPaths: ['~/.local/bin/agy'],
  },
}

/** where each link in a chain of symlinks points, until it is a file */
export function resolveLinks(path: string, readlink: (p: string) => string | null = readlinkOnce): string {
  let current = path
  for (let hop = 0; hop < 16; hop++) {
    const target = readlink(current)
    if (target === null) return current
    current = target.startsWith('/') ? target : join(dirname(current), target)
  }
  return current
}

// `readlink` without `-f`, which macOS only grew in 12.3: one hop at a time, resolved by the caller
function readlinkOnce(path: string): string | null {
  const proc = Bun.spawnSync([Bun.which('readlink') ?? '/usr/bin/readlink', path], { stdout: 'pipe', stderr: 'ignore' })
  if (proc.exitCode !== 0) return null
  const target = proc.stdout.toString().trim()
  return target === '' ? null : target
}

/**
 * which channel put this binary here. The path a person runs and the file it resolves to are both
 * read: Homebrew links /opt/homebrew/bin into its Cellar or Caskroom, npm links its bin into
 * node_modules, a vendor script writes where only that script writes, and a distribution package
 * lives under /usr or the nix store.
 */
export function channelOf(agent: AgentId, path: string, resolved: string, homeDir: string = home()): Channel {
  const both = [path, resolved]
  if (both.some((p) => p.includes('/Cellar/') || p.includes('/Caskroom/') || p.startsWith('/opt/homebrew/') || p.startsWith('/home/linuxbrew/'))) return 'brew'
  if (both.some((p) => p.includes('/.bun/install/global/')) || path.startsWith(`${homeDir}/.bun/bin/`)) return 'bun'
  if (both.some((p) => p.includes('/node_modules/'))) return 'npm'
  const marks = PACKAGING[agent].scriptPaths ?? []
  if (both.some((p) => marks.some((m) => p.includes(m)))) return 'script'
  if (both.some((p) => /^\/(?:usr\/)?s?bin\//.test(p) || /^\/(?:usr\/(?:lib|share)|nix\/store|snap)\//.test(p))) return 'system'
  return 'unknown'
}

/** the formula or cask a Homebrew path sits in: Caskroom/<cask>/... or Cellar/<formula>/... */
export function kegOf(path: string): Keg | null {
  const m = /\/(Caskroom|Cellar)\/([^/]+)\//.exec(path)
  return m ? { name: m[2]!, cask: m[1] === 'Caskroom' } : null
}

/** a channel, and for Homebrew the keg the binary sits in when its path names one */
export interface Origin {
  channel: Channel
  keg?: Keg | null
}

export interface Plan {
  /** what is about to run, as it would be typed */
  command: string
  argv: string[]
  /** how the choice was made, said beside it */
  why: string
}

/**
 * The update for a binary installed through `channel`. A package manager's install is updated by
 * that package manager - a self-updater replacing files brew or npm own leaves the manager out of
 * step, and claude's refuses outright on a Homebrew install - and anything else by the CLI's own
 * updater. A distribution's package is left to the distribution.
 */
export function updatePlan(agent: AgentId, origin: Origin | Channel, bin: string): Plan | { reason: string } {
  const { channel, keg } = typeof origin === 'string' ? { channel: origin, keg: undefined } : origin
  const p = PACKAGING[agent]
  if (channel === 'system') return { reason: `${bin} belongs to the system's package manager, which is what updates it` }
  const cask = channel === 'brew' ? brewTarget(p.brew, keg) : null
  if (cask) {
    const argv = ['brew', 'upgrade', ...(cask.cask ? ['--cask'] : []), cask.name]
    return { command: argv.join(' '), argv, why: 'installed with Homebrew' }
  }
  if (channel === 'npm' && p.npm) {
    const argv = ['npm', 'install', '-g', `${p.npm}@latest`]
    return { command: argv.join(' '), argv, why: 'installed with npm' }
  }
  if (channel === 'bun' && p.npm) {
    const argv = ['bun', 'add', '-g', `${p.npm}@latest`]
    return { command: argv.join(' '), argv, why: 'installed with bun' }
  }
  if (p.self) {
    const argv = [bin, ...p.self]
    return { command: argv.join(' '), argv, why: channel === 'script' ? 'installed by its own script, so its own updater' : 'its own updater' }
  }
  const first = p.install.find((r) => r.via === 'script')
  if (first) return { command: first.command, argv: [...first.argv], why: 'its installer, run again' }
  return { reason: `no documented update - see ${p.docs}` }
}

// The keg to upgrade: the one the binary sits in, which tells claude-code from claude-code@latest,
// as long as it is the vendor's; a keg that is not - a community cask of a CLI that updates itself -
// is left to that CLI's own updater rather than rolled back to whatever the cask last recorded.
function brewTarget(own: Keg | undefined, found: Keg | null | undefined): Keg | null {
  if (!own) return null
  if (!found) return own
  // by the name brew keeps it under, which it resolves to whichever tap it came from
  const base = own.name.slice(own.name.lastIndexOf('/') + 1)
  return found.name === base || found.name.startsWith(`${base}@`) ? found : null
}

/** the first documented install whose tools are here, or the one asked for by name */
export function installPlan(
  agent: AgentId,
  opts: { via?: Recipe['via']; has: (tool: string) => boolean },
): { plan: Plan; recipe: Recipe } | { reason: string } {
  const recipes = PACKAGING[agent].install
  if (recipes.length === 0) return { reason: `no documented install for ${agent} - see ${PACKAGING[agent].docs}` }
  const wanted = opts.via ? recipes.filter((r) => r.via === opts.via) : recipes
  if (wanted.length === 0) {
    return { reason: `${agent} is not installed with ${opts.via}; its documented ways are ${recipes.map((r) => r.via).join(', ')}` }
  }
  const ready = wanted.find((r) => r.needs.every((t) => opts.has(t)))
  if (!ready) {
    const missing = [...new Set(wanted.flatMap((r) => r.needs.filter((t) => !opts.has(t))))]
    return { reason: `${agent} needs ${missing.join(' or ')} to install (${wanted.map((r) => r.command).join('  |  ')})` }
  }
  return { plan: { command: ready.command, argv: [...ready.argv], why: `the vendor's ${ready.via} install` }, recipe: ready }
}
