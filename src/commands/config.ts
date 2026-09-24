import type { Config } from '../config/schema'
import { configSchema } from '../config/schema'
import { explain, globalConfigPath, projectConfigPath, readLayer, resolveAgent } from '../config/load'
import { agentIds } from '../adapters'
import { outputColor, table } from '../format'

export function coerce(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  // a list or an object is written as JSON: `config set failover.chain '["codex","claude"]'`
  if (/^[\[{]/.test(raw)) {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

// `__proto__` resolves to Object.prototype through an ordinary property read, so a dotted path
// containing it writes onto the shared prototype - poisoning every object in the process while
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

/** the layer without the key, and without any object the removal left empty */
export function unsetPath(obj: Record<string, unknown>, dotted: string): { next: Record<string, unknown>; found: boolean } {
  assertSafe(dotted)
  const keys: string[] = dotted.split('.')
  const out = structuredClone(obj)
  const trail: Record<string, unknown>[] = [out]
  let node: Record<string, unknown> = out
  for (const key of keys.slice(0, -1)) {
    const child = node[key]
    if (typeof child !== 'object' || child === null) return { next: obj, found: false }
    node = child as Record<string, unknown>
    trail.push(node)
  }
  const last = keys.at(-1)!
  if (!(last in node)) return { next: obj, found: false }
  delete node[last]
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]!).length > 0) break
    delete trail[i - 1]![keys[i - 1]!]
  }
  return { next: out, found: true }
}

// The keys a project file may not set (src/config/load.ts strips them, with a warning, at every
// load). Writing one there would report success and then be ignored on every run after it.
const PRIVILEGED = [/^gate(\.|$)/, /^defaults\.(permission|harness)$/, /^agents\.[^.]+\.(bin|permission|harness)$/]
export const isPrivileged = (dotted: string): boolean => PRIVILEGED.some((re) => re.test(dotted))

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
    // The same shape as a roster, so it reads like one: a row per agent, the source of the
    // resolved effort in its own column rather than in parentheses inside a key=value run-on.
    console.log(
      table(
        ['AGENT', 'MODEL', 'EFFORT', 'FROM', 'PERMISSION', 'HARNESS', 'ENABLED'],
        agentIds.map((agent) => {
          const s = resolveAgent(cfg, agent)
          return [
            agent,
            s.model ?? '-',
            s.effort,
            explain(cfg, agent, 'effort').source,
            s.permission,
            s.harness ?? 'by driver',
            s.enabled ? 'yes' : 'no',
          ]
        }),
        { color: outputColor() },
      ).trimEnd(),
    )
    return 0
  }

  if (action === 'path') {
    console.log(`global   ${globalConfigPath()}`)
    console.log(`project  ${projectConfigPath(cwd)}`)
    return 0
  }

  if (action === 'unset') {
    if (!key) {
      console.error('usage: konvoy config unset <key> [--global]')
      return 2
    }
    const path = opts.global ? globalConfigPath() : projectConfigPath(cwd)
    const raw = ((await readLayer(path)) ?? {}) as Record<string, unknown>
    let result: { next: Record<string, unknown>; found: boolean }
    try {
      result = unsetPath(raw, key)
    } catch (e) {
      console.error((e as Error).message)
      return 2
    }
    if (!result.found) {
      console.error(`${key} is not set in ${path}`)
      return 2
    }
    await Bun.write(path, JSON.stringify(result.next, null, 2) + '\n')
    console.log(`${key} unset  (${path})`)
    return 0
  }

  if (action === 'set') {
    if (!key || value === undefined) {
      console.error('usage: konvoy config set <key> <value> [--global]')
      return 2
    }
    if (!opts.global && isPrivileged(key)) {
      console.error(`refusing to write ${key} to the project config - it is privileged and only the global config may set it`)
      console.error(`  konvoy config set ${key} ${value} --global`)
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
      console.error(`refusing to write: ${issue?.path.join('.')} - ${issue?.message}`)
      return 2
    }
    await Bun.write(path, JSON.stringify(next, null, 2) + '\n')
    console.log(`${key} = ${value}  (${path})`)
    return 0
  }

  console.error('usage: konvoy config get|set|unset|path')
  return 2
}
