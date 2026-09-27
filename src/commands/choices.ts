import type { AgentId, Effort, Permission, Session } from '../types'
import type { Config } from '../config/schema'
import { agentIds, effortSchema, permissionSchema } from '../config/schema'
import { resolveAgent } from '../config/load'
import { CONFIG_KEYS, type ConfigKey } from '../config/keys'
import { getPath } from './config'
import type { Catalog } from '../core/models'
import type { PickItem, PickSpec } from '../editor'
import { ago, tildify } from '../format'

// What each REPL command offers when it is run without its word: the lists `/model`, `/effort`,
// `/permission`, `/use`, `/resume` and `/config set` open. Built here, apart from the REPL, so each
// list is a value a test can read rather than a screen it has to scrape.

export function modelChoices(agent: AgentId, catalog: Catalog | null, current: string | undefined): PickSpec {
  const items: PickItem[] = [
    { value: 'default', label: 'default', detail: `${agent}'s own choice of model`, current: current === undefined },
    ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: m.id, detail: m.detail, current: m.id === current })),
  ]
  // a model set in config that the list does not name stays visible, so the tick is never lost
  if (current !== undefined && !items.some((i) => i.value === current)) items.splice(1, 0, { value: current, label: current, detail: 'set now, not in the list', current: true })
  return {
    title: `Model for ${agent}`,
    subtitle: catalog ? `from ${catalog.source} · for this session` : `${agent} did not list its models - type a name`,
    items,
    ...(catalog?.complete ? {} : { custom: { label: (typed: string) => `use "${typed}"` } }),
  }
}

const EFFORT_WORDS: Record<Effort, string> = {
  low: 'quick answers, light reasoning',
  medium: 'balanced',
  high: "deeper reasoning - konvoy's default",
  max: 'the most the model offers',
}

export function effortChoices(agent: AgentId, current: Effort, supported?: readonly string[]): PickSpec {
  return {
    title: `Effort for ${agent}`,
    subtitle: 'for this session · konvoy maps it onto each CLI and clamps it to what the model supports',
    items: effortSchema.options.map((e) => ({
      value: e,
      label: e,
      detail: supported && supported.length > 0 && !supported.includes(e) ? `${EFFORT_WORDS[e]} - this model tops out lower, so it is clamped` : EFFORT_WORDS[e],
      current: e === current,
    })),
  }
}

// What each level means for each CLI, in its own terms (the README's permission table).
const PERMISSION_WORDS: Record<AgentId, Record<Permission, string>> = {
  claude: {
    safe: 'manual: reads; anything that asks is refused',
    edit: 'acceptEdits: edits files; anything else that asks is refused',
    auto: 'auto: runs everything, with background safety checks',
    yolo: 'bypassPermissions: runs everything, unchecked',
  },
  codex: {
    safe: 'read-only sandbox',
    edit: 'workspace-write sandbox; asks are refused',
    auto: '--approve-for-me: workspace-write, calls reviewed automatically',
    yolo: 'no sandbox, no approvals',
  },
  kiro: {
    safe: 'trusts no tools',
    edit: 'trusts read, write, search and shell',
    auto: 'the same tools as edit - kiro has no auto-review',
    yolo: 'trusts every tool',
  },
  opencode: {
    safe: 'its defaults: anything that asks is refused',
    edit: 'its defaults: anything that asks is refused',
    auto: '--auto: approves what is not explicitly denied',
    yolo: '--auto, its only approval switch',
  },
  antigravity: {
    safe: '--mode plan: plans, changes nothing',
    edit: '--mode accept-edits: edits files; commands are refused',
    auto: 'the same as edit - agy has no auto-review',
    yolo: '--dangerously-skip-permissions: runs everything',
  },
}

export function permissionChoices(agent: AgentId, current: Permission): PickSpec {
  return {
    title: `Permission for ${agent}`,
    subtitle: 'for this session · a turn runs headless, so a tool that would ask is refused',
    items: permissionSchema.options.map((p) => ({ value: p, label: p, detail: PERMISSION_WORDS[agent][p], current: p === current })),
  }
}

export const KONVOY = 'konvoy'

export interface AgentState {
  installed?: boolean
  /** set by a turn that failed on auth */
  signedOut?: boolean
}

export function agentChoices(cfg: Config, current: AgentId | typeof KONVOY, state: (a: AgentId) => AgentState): PickSpec {
  const items: PickItem[] = [
    { value: KONVOY, label: KONVOY, detail: 'konvoy picks: the lead first, the next agent when one runs out', current: current === KONVOY },
    ...agentIds.map((a) => {
      const s = resolveAgent(cfg, a)
      const st = state(a)
      const disabled = !s.enabled ? 'disabled in config' : st.installed === false ? `not installed - konvoy install ${a}` : undefined
      const detail = [s.model ?? 'its default model', s.effort, s.permission, st.signedOut ? 'signed out' : ''].filter(Boolean).join(' · ')
      return { value: a, label: a, detail, current: a === current, ...(disabled ? { disabled } : {}) }
    }),
  ]
  return { title: 'Talk to', subtitle: 'the context is shared: an agent is caught up on the turns it missed', items }
}

export interface SessionRow {
  session: Session
  turns: number
  lastAt: number | null
}

export function sessionChoices(rows: readonly SessionRow[], currentId: string, now: number): PickSpec {
  return {
    title: 'Resume a session',
    subtitle: 'newest first · its agents pick up where they left off',
    items: rows.map((r) => ({
      value: r.session.slug,
      label: r.session.slug,
      detail: [
        r.session.goal || '',
        `${r.turns} turn${r.turns === 1 ? '' : 's'}`,
        r.lastAt ? ago(r.lastAt, now) : 'no turns yet',
        tildify(r.session.cwd),
      ]
        .filter(Boolean)
        .join(' · '),
      current: r.session.id === currentId,
    })),
  }
}

function shown(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function configKeyChoices(cfg: Config): PickSpec {
  return {
    title: 'Set a config key',
    subtitle: 'written as plain JSON to the project or global file · * is global only',
    items: CONFIG_KEYS.map((k) => {
      const now = shown(getPath(cfg, k.key))
      return { value: k.key, label: `${k.key}${k.privileged ? ' *' : ''}`, detail: now ? `${now} · ${k.summary}` : k.summary }
    }),
  }
}

export function configValueChoices(key: ConfigKey, cfg: Config): PickSpec {
  const now = shown(getPath(cfg, key.key))
  const items: PickItem[] = (key.values ?? []).map((v) => ({ value: v, label: v, current: v === now }))
  return {
    title: key.key,
    subtitle: `${key.summary}${now ? ` · now ${now}` : ''}`,
    items,
    ...(key.values ? {} : { custom: { label: (typed: string) => `set it to ${typed}` } }),
  }
}

export function scopeChoices(key: ConfigKey): PickSpec {
  return {
    title: `Write ${key.key} to`,
    items: [
      { value: 'project', label: 'this project', detail: '.konvoy/config.jsonc, which can be committed', ...(key.privileged ? { disabled: 'only the global config may set it' } : {}) },
      { value: 'global', label: 'every project', detail: '~/.config/konvoy/config.jsonc' },
    ],
  }
}
