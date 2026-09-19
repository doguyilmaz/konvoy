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
  let result = ''
  let inString = false
  let i = 0

  function skipWhitespaceAndComments(start: number): number {
    let j = start
    while (j < text.length) {
      if (/\s/.test(text[j]!)) {
        j++
        continue
      }
      if (text[j] === '/' && text[j + 1] === '/') {
        while (j < text.length && text[j] !== '\n') j++
        if (j < text.length) j++
        continue
      }
      if (text[j] === '/' && text[j + 1] === '*') {
        j += 2
        while (j < text.length - 1) {
          if (text[j] === '*' && text[j + 1] === '/') {
            j += 2
            break
          }
          j++
        }
        continue
      }
      break
    }
    return j
  }

  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]

    if (inString) {
      result += char
      if (char === '\\' && next) {
        result += next
        i += 2
        continue
      }
      if (char === '"') {
        inString = false
      }
      i++
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      i++
      continue
    }

    if (char === '/' && next === '/') {
      let j = i
      while (j < text.length && text[j] !== '\n') j++
      if (j < text.length) result += '\n'
      i = j + 1
      continue
    }

    if (char === '/' && next === '*') {
      let j = i + 2
      while (j < text.length - 1) {
        if (text[j] === '*' && text[j + 1] === '/') {
          j += 2
          break
        }
        j++
      }
      i = j
      continue
    }

    if (char === ',' && !inString) {
      const j = skipWhitespaceAndComments(i + 1)
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        i = j
        continue
      }
      result += char
      i++
      continue
    }

    result += char
    i++
  }

  return result
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
    const mergedValue =
      value && typeof value === 'object' && !Array.isArray(value) && existing && typeof existing === 'object'
        ? merge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value
    Object.defineProperty(out, key, { value: mergedValue, enumerable: true, configurable: true, writable: true })
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
