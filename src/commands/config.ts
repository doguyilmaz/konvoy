import type { Config } from '../config/schema'
import { configSchema } from '../config/schema'
import { explain, globalConfigPath, projectConfigPath, readLayer, resolveAgent } from '../config/load'
import { agentIds } from '../adapters'

export function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

// `__proto__` resolves to Object.prototype through an ordinary property read, so a dotted path
// containing it writes onto the shared prototype — poisoning every object in the process while
// the config itself stays empty. `constructor` and `prototype` are blocked for the same reason.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

function assertSafe(dotted: string): void {
  for (const key of dotted.split('.')) {
    if (RESERVED.has(key)) throw new Error(`"${key}" is not a valid config key`)
  }
}

export function getPath(obj: unknown, dotted: string): unknown {
  assertSafe(dotted)
  let node: unknown = obj
  for (const key of dotted.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

export function setPath(
  obj: Record<string, unknown>,
  dotted: string,
  raw: string,
): Record<string, unknown> {
  assertSafe(dotted)
  const keys = dotted.split('.')
  const out = structuredClone(obj)
  let node: Record<string, unknown> = out
  for (const key of keys.slice(0, -1)) {
    const child = node[key]
    if (typeof child !== 'object' || child === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys.at(-1)!] = coerce(raw)
  return out
}

export async function cmdConfig(
  cfg: Config,
  cwd: string,
  action: string,
  key?: string,
  value?: string,
  opts: { global?: boolean } = {},
): Promise<number> {
  if (action === 'get') {
    if (key) {
      let found: unknown
      try {
        found = getPath(cfg, key)
      } catch (e) {
        console.error((e as Error).message)
        return 2
      }
      if (found === undefined) {
        console.error(`no such config key: ${key}`)
        return 2
      }
      console.log(typeof found === 'string' ? found : JSON.stringify(found, null, 2))
      return 0
    }
    for (const agent of agentIds) {
      const s = resolveAgent(cfg, agent)
      const effort = explain(cfg, agent, 'effort')
      console.log(
        `${agent}: model=${s.model ?? '-'} effort=${s.effort} (${effort.source}) permission=${s.permission} enabled=${s.enabled}`,
      )
    }
    return 0
  }

  if (action === 'set') {
    if (!key || value === undefined) {
      console.error('usage: konvoy config set <key> <value> [--global]')
      return 2
    }
    const path = opts.global ? globalConfigPath() : projectConfigPath(cwd)
    const raw = ((await readLayer(path)) ?? {}) as Record<string, unknown>
    let next: Record<string, unknown>
    try {
      next = setPath(raw, key, value)
    } catch (e) {
      console.error((e as Error).message)
      return 2
    }
    const parsed = configSchema.safeParse(next)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      console.error(`refusing to write: ${issue?.path.join('.')} — ${issue?.message}`)
      return 2
    }
    await Bun.write(path, JSON.stringify(next, null, 2) + '\n')
    console.log(`${key} = ${value}  (${path})`)
    return 0
  }

  console.error('usage: konvoy config get|set')
  return 2
}
