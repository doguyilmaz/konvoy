import type { AgentId } from '../types'
import { getAdapter } from '../adapters'
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
  detail?: string
}

export type Runner = (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>

export interface DetectDeps {
  run: Runner
  readText: (path: string) => Promise<string | null>
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
}

const AUTH_CHECK: Record<AgentId, (bin?: string) => string[]> = {
  claude: (bin = 'claude') => [bin, 'auth', 'status'],
  codex: () => ['codex', 'login', 'status'],
  kiro: (bin = 'kiro-cli') => [bin, 'whoami'],
  opencode: () => ['opencode', 'auth', 'list'],
}

async function codexEfforts(deps: DetectDeps, model?: string): Promise<readonly string[] | undefined> {
  if (!model) return undefined
  const raw = await deps.readText(join(home(), '.codex', 'models_cache.json'))
  if (!raw) return undefined
  try {
    const cache = JSON.parse(raw) as { models?: unknown }
    if (!Array.isArray(cache.models)) return undefined
    const hit = (cache.models as { id?: string; supported_reasoning_levels?: unknown }[]).find(
      (m) => m.id === model,
    )
    return Array.isArray(hit?.supported_reasoning_levels)
      ? (hit.supported_reasoning_levels as string[])
      : undefined
  } catch {
    return undefined
  }
}

function parseAuthStatus(agent: AgentId, stdout: string): boolean | null {
  if (!stdout) return null
  try {
    const json = JSON.parse(stdout) as { loggedIn?: unknown }
    if (typeof json.loggedIn === 'boolean') return json.loggedIn
  } catch {
    if (agent === 'kiro' && stdout.includes('Logged in')) return true
    if (agent === 'codex' && stdout.includes('Logged in')) return true
    if (agent === 'opencode' && stdout.trim().length > 0) return true
  }
  return null
}

export async function detectWith(deps: DetectDeps, agent: AgentId, model?: string): Promise<Detection> {
  const adapter = getAdapter(agent)
  const result = await deps.run([adapter.bin, '--version'])
  const installed = result.exitCode === 0
  const version = installed ? parseVersion(result.stdout) : null
  const efforts = installed && agent === 'codex' ? await codexEfforts(deps, model) : undefined
  return { agent, installed, version, efforts }
}

export async function detectAuthWith(
  deps: DetectDeps,
  agent: AgentId,
  bin?: string,
): Promise<AuthState> {
  const cmd = AUTH_CHECK[agent](bin)
  const result = await deps.run(cmd)
  const authed = result.exitCode === 127 ? null : parseAuthStatus(agent, result.stdout)
  return { agent, authed }
}

function memo<K, V>(cacheMap: Map<K, Promise<V>>) {
  return (f: (k: K) => Promise<V>): ((k: K) => Promise<V>) => {
    return (k: K) => {
      const hit = cacheMap.get(k)
      if (hit) return hit
      const pending = f(k)
        .then((v) => {
          cacheMap.set(k, Promise.resolve(v))
          return v
        })
        .catch((e) => {
          cacheMap.delete(k)
          throw e
        })
      cacheMap.set(k, pending)
      return pending
    }
  }
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

const memoDetect = memo(detectCacheMap)(async (key: string) => {
  const [agent, model] = key.split('\u0000') as [AgentId, string | undefined]
  return detectUncached(agent, model || undefined)
})

const memoDetectAuth = memo(detectAuthCacheMap)(async (key: string) => {
  const [agent, bin] = key.split('\u0000') as [AgentId, string | undefined]
  return detectAuthUncached(agent, bin || undefined)
})

export function clearDetectCache(): void {
  detectCacheMap.clear()
  detectAuthCacheMap.clear()
}

export async function detect(agent: AgentId, model?: string): Promise<Detection> {
  const key = `${agent}\u0000${model ?? ''}`
  return memoDetect(key)
}

export async function detectAuth(agent: AgentId, bin?: string): Promise<AuthState> {
  const key = `${agent}\u0000${bin ?? ''}`
  return memoDetectAuth(key)
}

export function createDetectWithMemo(deps: DetectDeps) {
  const cacheMap = new Map<string, Promise<Detection>>()
  const memoized = memo(cacheMap)(async (key: string) => {
    const [agent, model] = key.split('\u0000') as [AgentId, string | undefined]
    return detectWith(deps, agent, model || undefined)
  })
  return async (agent: AgentId, model?: string): Promise<Detection> => {
    const key = `${agent}\u0000${model ?? ''}`
    return memoized(key)
  }
}

export function createDetectAuthWithMemo(deps: DetectDeps) {
  const cacheMap = new Map<string, Promise<AuthState>>()
  const memoized = memo(cacheMap)(async (key: string) => {
    const [agent, bin] = key.split('\u0000') as [AgentId, string | undefined]
    return detectAuthWith(deps, agent, bin)
  })
  return async (agent: AgentId, bin?: string): Promise<AuthState> => {
    const key = `${agent}\u0000${bin ?? ''}`
    return memoized(key)
  }
}

async function detectUncached(agent: AgentId, model?: string): Promise<Detection> {
  return detectWith(realDeps(), agent, model)
}

async function detectAuthUncached(agent: AgentId, bin?: string): Promise<AuthState> {
  return detectAuthWith(realDeps(), agent, bin)
}
