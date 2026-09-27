import type { AgentId } from '../types'
import { getAdapter } from '../adapters'
import { oneLine, safeJson, stripControlChars } from '../adapters/types'
import { home, join } from '../paths'

// The models each CLI will run, asked of the CLI itself, so `/model` can offer a list rather than
// accept any string and let the turn fail on it: "Invalid model reference: opus-5-5" came back
// from a name opencode never offered. Each source is the vendor's own:
//   claude    its aliases (a full model id works as well, so the list is not the whole set)
//   codex     ~/.codex/models_cache.json, the list codex itself fetched for the account
//   kiro      kiro-cli chat --list-models --format json
//   opencode  opencode models, "provider/model" per line, for the providers configured
//   agy       agy models --output-format json (1.1.12 and later)

export interface ModelChoice {
  id: string
  /** a display name or a line about the model, as the CLI gives it */
  detail?: string
}

export interface Catalog {
  models: ModelChoice[]
  /** a name outside the list is one the CLI would refuse, so konvoy refuses it first */
  complete: boolean
  /** where the list came from, said under the picker */
  source: string
}

export interface CatalogDeps {
  run: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>
  readText: (path: string) => Promise<string | null>
}

const CLAUDE_ALIASES: ModelChoice[] = [
  { id: 'opus', detail: 'the most capable Claude model' },
  { id: 'sonnet', detail: 'fast and capable, for everyday work' },
  { id: 'haiku', detail: 'the fastest' },
]

export async function listModels(agent: AgentId, deps: CatalogDeps, bin?: string): Promise<Catalog | null> {
  const exe = bin ?? getAdapter(agent).bin
  switch (agent) {
    case 'claude':
      return { models: CLAUDE_ALIASES, complete: false, source: "claude's aliases - a full model id works too" }
    case 'codex': {
      const raw = await deps.readText(join(home(), '.codex', 'models_cache.json'))
      const models = raw ? modelsFromJson(safeParse(raw)) : []
      return models.length > 0 ? { models, complete: true, source: "codex's own model list (~/.codex/models_cache.json)" } : null
    }
    case 'kiro': {
      const json = await deps.run([exe, 'chat', '--list-models', '--format', 'json'])
      const models = json.exitCode === 0 ? modelsFromJson(safeParse(json.stdout)) : []
      if (models.length > 0) return { models, complete: true, source: 'kiro-cli chat --list-models' }
      const text = await deps.run([exe, 'chat', '--list-models'])
      const plain = text.exitCode === 0 ? modelsFromText(text.stdout) : []
      return plain.length > 0 ? { models: plain, complete: true, source: 'kiro-cli chat --list-models' } : null
    }
    case 'opencode': {
      const out = await deps.run([exe, 'models'])
      const models = out.exitCode === 0 ? modelsFromText(out.stdout).filter((m) => m.id.includes('/')) : []
      return models.length > 0 ? { models, complete: true, source: 'opencode models, for the providers you have configured' } : null
    }
    case 'antigravity': {
      const json = await deps.run([exe, 'models', '--output-format', 'json'])
      const models = json.exitCode === 0 ? modelsFromJson(safeParse(json.stdout)) : []
      if (models.length > 0) return { models, complete: true, source: 'agy models' }
      const text = await deps.run([exe, 'models'])
      const plain = text.exitCode === 0 ? modelsFromText(text.stdout) : []
      return plain.length > 0 ? { models: plain, complete: true, source: 'agy models' } : null
    }
  }
}

function safeParse(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // a CLI that prints one JSON object per line
    const rows = trimmed.split('\n').map((l) => safeJson(l)).filter((o): o is Record<string, unknown> => o !== null)
    return rows.length > 0 ? rows : null
  }
}

const ID_KEYS = ['id', 'modelId', 'model_id', 'slug', 'model', 'name', 'value'] as const
const DETAIL_KEYS = ['display_name', 'displayName', 'label', 'title', 'description', 'name'] as const
const LIST_KEYS = ['models', 'data', 'items', 'availableModels', 'available_models', 'result'] as const

// The shape each CLI's JSON takes is its own and not documented, so this reads the shapes a model
// list comes in: a list of ids, a list of objects naming one, or either under a wrapping key.
export function modelsFromJson(value: unknown): ModelChoice[] {
  const list = asList(value)
  const out: ModelChoice[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const choice = typeof entry === 'string' ? { id: entry } : typeof entry === 'object' && entry !== null ? fromObject(entry as Record<string, unknown>) : null
    if (!choice) continue
    const id = stripControlChars(choice.id).trim()
    if (id === '' || seen.has(id) || !/^[\w.:@/-]+$/.test(id)) continue
    seen.add(id)
    out.push(choice.detail ? { id, detail: oneLine(choice.detail, 80) } : { id })
  }
  return out
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return []
  const o = value as Record<string, unknown>
  for (const key of LIST_KEYS) if (Array.isArray(o[key])) return o[key] as unknown[]
  for (const key of LIST_KEYS) if (typeof o[key] === 'object' && o[key] !== null) return asList(o[key])
  // keyed by id: { "gemini-3.6-flash": { ... }, ... }
  const entries = Object.entries(o).filter(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v))
  return entries.length > 0 && entries.length === Object.keys(o).length ? entries.map(([id, v]) => ({ id, ...(v as object) })) : []
}

function fromObject(o: Record<string, unknown>): ModelChoice | null {
  // a model the CLI lists but keeps out of its own picker is not one to offer
  if (o.hidden === true || o.visibility === 'hide' || o.visibility === 'hidden' || o.enabled === false) return null
  const idKey = ID_KEYS.find((k) => typeof o[k] === 'string' && (o[k] as string).trim() !== '')
  if (!idKey) return null
  const id = o[idKey] as string
  const detailKey = DETAIL_KEYS.find((k) => k !== idKey && typeof o[k] === 'string' && (o[k] as string).trim() !== '' && o[k] !== id)
  return detailKey ? { id, detail: o[detailKey] as string } : { id }
}

// A model per line, as `opencode models` prints it; a bullet or a table row keeps its first token.
// A heading ("Available models:") is not a model: an id has a digit, a dash, a dot, a colon or a
// slash in it, which no heading word does.
export function modelsFromText(stdout: string): ModelChoice[] {
  const out: ModelChoice[] = []
  const seen = new Set<string>()
  for (const raw of stdout.split(/\r?\n/)) {
    const line = stripControlChars(raw).replace(/^[\s*•\-–>|]+/, '').trim()
    const [token, ...rest] = line.split(/\s+/)
    if (!token || !/^[A-Za-z0-9][\w.:@/-]*$/.test(token) || !/[\d.:/-]/.test(token) || seen.has(token)) continue
    seen.add(token)
    const detail = rest.join(' ').replace(/^[\s|:–-]+/, '').trim()
    out.push(detail ? { id: token, detail: oneLine(detail, 80) } : { id: token })
  }
  return out
}

/** the models' ids closest to what was typed, for "did you mean" */
export function nearestModels(typed: string, catalog: Catalog, n = 2): string[] {
  const t = typed.toLowerCase()
  const scored = catalog.models.map((m) => {
    const id = m.id.toLowerCase()
    const tail = id.slice(id.lastIndexOf('/') + 1)
    const score = id.includes(t) || tail.includes(t) ? 0 : Math.min(distance(t, id), distance(t, tail))
    return { id: m.id, score }
  })
  return scored
    .filter((s) => s.score <= Math.max(2, Math.floor(t.length / 3)))
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((s) => s.id)
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]!
}

export function realCatalogDeps(timeoutMs = 10_000): CatalogDeps {
  return {
    run: async (argv) => {
      try {
        // stdin closed: agy's `models` once hung on an inherited, unclosed pipe (its changelog)
        const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs })
        const stdout = await new Response(proc.stdout).text()
        return { stdout, exitCode: await proc.exited }
      } catch {
        return { stdout: '', exitCode: 127 }
      }
    },
    readText: async (path) => {
      const file = Bun.file(path)
      return (await file.exists()) ? file.text() : null
    },
  }
}
