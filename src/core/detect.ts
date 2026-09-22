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

export async function detectWith(
  deps: DetectDeps,
  agent: AgentId,
  opts: { model?: string; bin?: string } = {},
): Promise<Detection> {
  const adapter = getAdapter(agent)
  const result = await deps.run([opts.bin ?? adapter.bin, '--version'])
  const installed = result.exitCode === 0
  const version = installed ? parseVersion(result.stdout) : null
  const efforts = installed && agent === 'codex' ? await codexEfforts(deps, opts.model) : undefined
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
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()
        const exitCode = await proc.exited
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

export async function detect(agent: AgentId, opts: DetectOptions = {}): Promise<Detection> {
  const key = `${scope(opts.deps)}\u0000${agent}\u0000${opts.model ?? ''}\u0000${opts.bin ?? ''}`
  return memo(detectCacheMap, key, () => detectWith(opts.deps ?? realDeps(), agent, opts))
}

export async function detectAuth(agent: AgentId, opts: DetectOptions = {}): Promise<AuthState> {
  const key = `${scope(opts.deps)}\u0000${agent}\u0000${opts.bin ?? ''}`
  return memo(detectAuthCacheMap, key, () => detectAuthWith(opts.deps ?? realDeps(), agent, opts.bin))
}
