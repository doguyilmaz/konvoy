import type { AgentId } from '../types'
import { getAdapter } from '../adapters'
import { stripControlChars } from '../adapters/types'
import { home, join } from '../paths'

export interface Detection {
  agent: AgentId
  installed: boolean
  version: string | null
  efforts?: readonly string[]
}

export interface AuthState {
  agent: AgentId
  authed: boolean | null
  detail: string
}

export type Runner = (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>

export interface DetectDeps {
  run: Runner
  readText: (path: string) => Promise<string | null>
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
}

interface AuthCheck {
  args: string[]
  ok: (stdout: string, exitCode: number) => boolean | null
}

const AUTH_CHECK: Record<AgentId, (bin?: string) => AuthCheck> = {
  claude: (bin = 'claude') => ({
    args: [bin, 'auth', 'status'],
    ok: (stdout, exitCode) => {
      if (!stdout) return null
      try {
        const json = JSON.parse(stdout) as { loggedIn?: unknown }
        if (typeof json.loggedIn === 'boolean') return json.loggedIn
      } catch {
        // not JSON, fall through
      }
      return null
    },
  }),
  codex: (bin = 'codex') => ({
    args: [bin, 'login', 'status'],
    ok: (stdout, exitCode) => {
      if (!stdout || exitCode !== 0) return null
      return stdout.includes('Logged in')
    },
  }),
  kiro: (bin = 'kiro-cli') => ({
    args: [bin, 'whoami'],
    ok: (stdout, exitCode) => {
      if (!stdout || exitCode !== 0) return null
      return stdout.includes('Logged in')
    },
  }),
  opencode: (bin = 'opencode') => ({
    args: [bin, 'auth', 'list'],
    ok: (stdout, exitCode) => {
      if (exitCode !== 0) return null
      return stdout.trim().length > 0
    },
  }),
  // agy has no auth subcommand: signing in happens in the interactive CLI. `models` is the
  // cheapest command that still needs the server, so a working login is what makes it exit 0.
  antigravity: (bin = 'agy') => ({
    args: [bin, 'models'],
    ok: (stdout, exitCode) => {
      if (exitCode !== 0) return null
      return stdout.trim().length > 0
    },
  }),
}

async function codexEfforts(deps: DetectDeps, model?: string): Promise<readonly string[] | undefined> {
  if (!model) return undefined
  const raw = await deps.readText(join(home(), '.codex', 'models_cache.json'))
  if (!raw) return undefined
  try {
    const cache = JSON.parse(raw) as { models?: unknown }
    if (!Array.isArray(cache.models)) return undefined
    // the real file (codex 0.155.1, 2026-09-21) keys models by `slug` and lists each level as
    // `{ effort, description }` - see tests/fixtures/codex-models-cache.json
    const hit = (cache.models as { slug?: string; supported_reasoning_levels?: unknown }[]).find(
      (m) => m.slug === model,
    )
    if (!Array.isArray(hit?.supported_reasoning_levels)) return undefined
    const levels = hit.supported_reasoning_levels.flatMap((l) =>
      typeof (l as { effort?: unknown } | null)?.effort === 'string' ? [(l as { effort: string }).effort] : [],
    )
    return levels.length > 0 ? levels : undefined
  } catch {
    return undefined
  }
}

function authDetail(stdout: string, exitCode: number): string {
  if (exitCode === 127) return 'not installed'
  const trimmed = stdout.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { loggedIn?: unknown; authMethod?: unknown }
      const via = typeof parsed.authMethod === 'string' ? ` via ${stripControlChars(parsed.authMethod)}` : ''
      if (parsed.loggedIn === true) return `logged in${via}`
      if (parsed.loggedIn === false) return 'not logged in'
    } catch {
      // not the shape we expected; the first line is still better than nothing
    }
  }
  return stripControlChars(trimmed.split('\n')[0] ?? '')
}

// opencode's effort is a model VARIANT (`-m opencode/claude-opus-4-8#high`), and naming one a model
// does not have refuses the turn. The only non-guessing source is opencode's own cached registry
// (models.dev data), where an effort-tunable model carries reasoning_options of type "effort" with
// its values enumerated, and a model tuned by thinking budget instead carries "budget_tokens".
// Three outcomes, deliberately distinct: the values, [] for a model the registry says has none,
// and undefined when konvoy cannot tell (no model configured, unknown model, no readable registry).
async function opencodeEfforts(deps: DetectDeps, model?: string): Promise<readonly string[] | undefined> {
  if (!model) return undefined
  const raw = await deps.readText(join(home(), '.cache', 'opencode', 'models.json'))
  if (!raw) return undefined
  try {
    const registry = JSON.parse(raw) as Record<string, { models?: Record<string, unknown> }>
    // a configured model is "provider/id", and the provider names the registry entry to look in
    const slash = model.indexOf('/')
    const provider = slash === -1 ? 'opencode' : model.slice(0, slash)
    const id = slash === -1 ? model : model.slice(slash + 1)
    const entry = registry[provider]?.models?.[id]
    if (!entry || typeof entry !== 'object') return undefined
    const options = (entry as { reasoning_options?: unknown }).reasoning_options
    if (!Array.isArray(options)) return []
    const effort = options.find(
      (o): o is { type: string; values?: unknown } =>
        typeof o === 'object' && o !== null && (o as { type?: unknown }).type === 'effort',
    )
    const values = effort?.values
    if (!Array.isArray(values)) return []
    return values.filter((v): v is string => typeof v === 'string')
  } catch {
    return undefined
  }
}

export async function detectWith(
  deps: DetectDeps,
  agent: AgentId,
  opts: { model?: string; bin?: string } = {},
): Promise<Detection> {
  const adapter = getAdapter(agent)
  const result = await deps.run([opts.bin ?? adapter.bin, '--version'])
  const installed = result.exitCode === 0
  const version = installed ? parseVersion(result.stdout) : null
  const efforts = !installed
    ? undefined
    : agent === 'codex'
      ? await codexEfforts(deps, opts.model)
      : agent === 'opencode'
        ? await opencodeEfforts(deps, opts.model)
        : undefined
  return { agent, installed, version, efforts }
}

export async function detectAuthWith(
  deps: DetectDeps,
  agent: AgentId,
  bin?: string,
): Promise<AuthState> {
  const check = AUTH_CHECK[agent](bin)
  const result = await deps.run(check.args)
  const detail = authDetail(result.stdout, result.exitCode)
  if (result.exitCode === 127) {
    return { agent, authed: null, detail }
  }
  const authed = check.ok(result.stdout, result.exitCode)
  return { agent, authed, detail }
}

function memo<K, V>(cacheMap: Map<K, Promise<V>>, key: K, f: () => Promise<V>): Promise<V> {
  const hit = cacheMap.get(key)
  if (hit) return hit
  const pending = f()
    .then((v) => {
      cacheMap.set(key, Promise.resolve(v))
      return v
    })
    .catch((e) => {
      cacheMap.delete(key)
      throw e
    })
  cacheMap.set(key, pending)
  return pending
}

function realDeps(): DetectDeps {
  return {
    run: async (cmd) => {
      try {
        const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
        // both at once: a CLI that fills the stderr pipe while its stdout is still being read
        // would otherwise block on the write, and the read on it, until the timeout
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { stdout: stdout || stderr, exitCode }
      } catch {
        return { stdout: '', exitCode: 127 }
      }
    },
    readText: async (path) => {
      try {
        const file = Bun.file(path)
        return (await file.exists()) ? file.text() : null
      } catch {
        return null
      }
    },
  }
}

const detectCacheMap = new Map<string, Promise<Detection>>()
const detectAuthCacheMap = new Map<string, Promise<AuthState>>()

// one memo per injected deps object; real detection shares its own
const depsIds = new WeakMap<DetectDeps, number>()
let nextDepsId = 0
function scope(deps?: DetectDeps): string {
  if (!deps) return 'real'
  let id = depsIds.get(deps)
  if (id === undefined) depsIds.set(deps, (id = ++nextDepsId))
  return String(id)
}

export function clearDetectCache(): void {
  detectCacheMap.clear()
  detectAuthCacheMap.clear()
}

export interface DetectOptions {
  model?: string
  bin?: string
  deps?: DetectDeps
}

// What a turn needs to know, without running the agent: whether its binary is there and which
// efforts its model takes. `detect` spawns `<bin> --version` for a version nothing on the turn
// path reads, and a node-based CLI takes the better part of a second to print it. A binary that is
// present but cannot start still fails the turn, where turn.ts records why.
export async function locate(agent: AgentId, opts: DetectOptions = {}): Promise<Detection> {
  const deps = opts.deps ?? realDeps()
  const bin = opts.bin ?? getAdapter(agent).bin
  const found = bin.includes('/') ? await Bun.file(bin).exists() : Bun.which(bin) !== null
  if (!found) return { agent, installed: false, version: null }
  const efforts =
    agent === 'codex' ? await codexEfforts(deps, opts.model) : agent === 'opencode' ? await opencodeEfforts(deps, opts.model) : undefined
  return { agent, installed: true, version: null, efforts }
}

export async function detect(agent: AgentId, opts: DetectOptions = {}): Promise<Detection> {
  const key = `${scope(opts.deps)}\u0000${agent}\u0000${opts.model ?? ''}\u0000${opts.bin ?? ''}`
  return memo(detectCacheMap, key, () => detectWith(opts.deps ?? realDeps(), agent, opts))
}

export async function detectAuth(agent: AgentId, opts: DetectOptions = {}): Promise<AuthState> {
  const key = `${scope(opts.deps)}\u0000${agent}\u0000${opts.bin ?? ''}`
  return memo(detectAuthCacheMap, key, () => detectAuthWith(opts.deps ?? realDeps(), agent, opts.bin))
}
