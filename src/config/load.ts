import { configSchema, type AgentId, type Config, type Effort, type Harness, type Permission } from './schema'
import { configDir, join } from '../paths'

export const globalConfigPath = (): string => join(configDir(), 'config.jsonc')
export const projectConfigPath = (cwd: string): string => join(cwd, '.konvoy', 'config.jsonc')

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

export async function readLayer(path: string): Promise<unknown> {
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

// `defineProperty` rather than `out[id] = value`: `id` comes from an attacker-controlled JSON
// key (an agent id in a cloned repo's config), and plain bracket assignment on a plain object
// triggers the `__proto__` setter instead of creating an own property.
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// bin, permission and harness decide what konvoy runs and how much it trusts the process it
// spawns — properties of the machine the person is running konvoy on, not of the repo they
// cloned. A project layer may not set them at any level they appear; only the global config can.
const PRIVILEGED_DEFAULTS_KEYS = ['permission', 'harness'] as const
const PRIVILEGED_AGENT_KEYS = ['bin', 'permission', 'harness'] as const

function warnIgnored(path: string): void {
  console.error(`konvoy: ignoring project-level "${path}" — privileged, set it in the global config instead`)
}

function stripProjectPrivileges(layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...layer }

  if (isPlainObject(out.defaults)) {
    const cleaned = { ...out.defaults }
    for (const key of PRIVILEGED_DEFAULTS_KEYS) {
      if (key in cleaned) {
        warnIgnored(`defaults.${key}`)
        delete cleaned[key]
      }
    }
    out.defaults = cleaned
  }

  if (isPlainObject(out.agents)) {
    const cleanedAgents: Record<string, unknown> = {}
    for (const [id, agentCfg] of Object.entries(out.agents)) {
      if (!isPlainObject(agentCfg)) {
        setOwn(cleanedAgents, id, agentCfg)
        continue
      }
      const cleaned = { ...agentCfg }
      for (const key of PRIVILEGED_AGENT_KEYS) {
        if (key in cleaned) {
          warnIgnored(`agents.${id}.${key}`)
          delete cleaned[key]
        }
      }
      setOwn(cleanedAgents, id, cleaned)
    }
    out.agents = cleanedAgents
  }

  return out
}

// A leading dash is what makes a model string dangerous: spawned with `--model <value>`, it
// lands as the next argv token with no `--` guard, unlike the prompt. Unlike bin/permission/
// harness, a project may legitimately pin a model — so this is validated, not merge-source
// restricted, and applies to whichever layer's value survives the merge.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function stripInvalidModels(layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...layer }
  if (!isPlainObject(out.agents)) return out

  const cleanedAgents: Record<string, unknown> = {}
  for (const [id, agentCfg] of Object.entries(out.agents)) {
    if (!isPlainObject(agentCfg)) {
      setOwn(cleanedAgents, id, agentCfg)
      continue
    }
    const cleaned = { ...agentCfg }
    if (typeof cleaned.model === 'string' && !MODEL_PATTERN.test(cleaned.model)) {
      console.error(`konvoy: ignoring invalid agents.${id}.model "${cleaned.model}" — must match ${MODEL_PATTERN}`)
      delete cleaned.model
    }
    setOwn(cleanedAgents, id, cleaned)
  }
  out.agents = cleanedAgents
  return out
}

export async function loadConfig(opts: { cwd: string; globalPath?: string }): Promise<Config> {
  const globalPath = opts.globalPath ?? globalConfigPath()
  const globalLayer = (await readLayer(globalPath)) as Record<string, unknown>
  const projectLayer = stripProjectPrivileges((await readLayer(projectConfigPath(opts.cwd))) as Record<string, unknown>)
  const merged = stripInvalidModels(merge(globalLayer, projectLayer))
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
