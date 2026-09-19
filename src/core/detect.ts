import type { AgentId } from '../types'
import { getAdapter } from '../adapters'
import { home, join } from '../paths'

export interface Detection {
  agent: AgentId
  installed: boolean
  version: string | null
  authed: boolean | null
  efforts?: readonly string[]
}

export type Runner = (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>

export interface DetectDeps {
  run: Runner
  exists: (path: string) => Promise<boolean>
  readText: (path: string) => Promise<string | null>
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
}

const AUTH_FILE: Record<AgentId, string[]> = {
  claude: ['.claude/.credentials.json'],
  codex: ['.codex/auth.json'],
  kiro: ['Library/Application Support/kiro-cli'],
  opencode: ['.local/share/opencode/auth.json'],
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

export async function detectWith(deps: DetectDeps, agent: AgentId, model?: string): Promise<Detection> {
  const adapter = getAdapter(agent)
  const result = await deps.run([adapter.bin, '--version'])
  const installed = result.exitCode === 0
  const version = installed ? parseVersion(result.stdout) : null

  let authed: boolean | null = null
  if (installed) {
    authed = false
    for (const rel of AUTH_FILE[agent]) {
      if (await deps.exists(join(home(), rel))) {
        authed = true
        break
      }
    }
    if (agent === 'claude' && !authed && Bun.env.ANTHROPIC_API_KEY) authed = true
  }

  const efforts = installed && agent === 'codex' ? await codexEfforts(deps, model) : undefined
  return { agent, installed, version, authed, efforts }
}

const cache = new Map<string, Promise<Detection>>()

export function clearDetectCache(): void {
  cache.clear()
}

export async function detect(agent: AgentId, model?: string): Promise<Detection> {
  const key = `${agent}:${model ?? ''}`
  const hit = cache.get(key)
  if (hit) return hit
  const pending = detectUncached(agent, model)
  cache.set(key, pending)
  return pending
}

async function detectUncached(agent: AgentId, model?: string): Promise<Detection> {
  return detectWith(
    {
      run: async (cmd) => {
        try {
          const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
          const stdout = await new Response(proc.stdout).text()
          const exitCode = await proc.exited
          return { stdout, exitCode }
        } catch {
          return { stdout: '', exitCode: 127 }
        }
      },
      exists: (path) => Bun.file(path).exists(),
      readText: async (path) => {
        const file = Bun.file(path)
        return (await file.exists()) ? file.text() : null
      },
    },
    agent,
    model,
  )
}
