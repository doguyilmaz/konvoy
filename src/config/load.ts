import { configSchema, type AgentId, type Config, type Effort, type Harness, type Permission } from './schema'
import { configDir, join } from '../paths'

export interface AgentSettings {
  enabled: boolean
  model?: string
  effort: Effort
  permission: Permission
  harness: Harness
  bin?: string
  subagentEffort?: Effort
}

function stripJsonc(text: string): string {
  const out = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return out.replace(/,(\s*[}\]])/g, '$1')
}

async function readLayer(path: string): Promise<unknown> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  return JSON.parse(stripJsonc(await file.text()))
}

function merge(base: Record<string, unknown>, top: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(top)) {
    const existing = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && existing && typeof existing === 'object') {
      out[key] = merge(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

export async function loadConfig(opts: { cwd: string; globalPath?: string }): Promise<Config> {
  const globalPath = opts.globalPath ?? join(configDir(), 'config.jsonc')
  const layers = [await readLayer(globalPath), await readLayer(join(opts.cwd, '.konvoy', 'config.jsonc'))]
  const merged = layers.reduce<Record<string, unknown>>(
    (acc, layer) => merge(acc, layer as Record<string, unknown>),
    {},
  )
  const parsed = configSchema.safeParse(merged)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    let pathStr = issue?.path.join('.')
    if (issue?.code === 'unrecognized_keys' && (issue as any).keys && (issue as any).keys.length > 0) {
      const keyPath = [...issue.path, (issue as any).keys[0]].join('.')
      pathStr = keyPath
    }
    throw new Error(`invalid konvoy config at ${pathStr}: ${issue?.message}`)
  }
  return parsed.data
}

export function resolveAgent(cfg: Config, agent: AgentId): AgentSettings {
  const a = cfg.agents[agent] ?? {}
  return {
    enabled: a.enabled ?? true,
    model: a.model,
    effort: a.effort ?? cfg.defaults.effort,
    permission: a.permission ?? cfg.defaults.permission,
    harness: a.harness ?? cfg.defaults.harness,
    bin: a.bin,
    subagentEffort: a.subagentEffort,
  }
}

export function explain(
  cfg: Config,
  agent: AgentId,
  key: 'effort' | 'permission' | 'model',
): { value: string | undefined; source: 'agent' | 'defaults' | 'built-in' } {
  const a = cfg.agents[agent] ?? {}
  if (a[key] !== undefined) return { value: a[key], source: 'agent' }
  if (key === 'model') return { value: undefined, source: 'built-in' }
  return { value: cfg.defaults[key], source: 'defaults' }
}
