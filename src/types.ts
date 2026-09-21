import type { AgentId, Effort, Permission, Style } from './config/schema'

export type { AgentId, Effort, Permission, Style }

export type KonvoyEvent =
  | { t: 'session'; foreignId: string }
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'tool'; name: string; status: 'start' | 'ok' | 'error' }
  | { t: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; credits?: number }
  | {
      t: 'error'
      message: string
      kind: 'auth' | 'rate' | 'upstream' | 'crash' | 'timeout' | 'interrupted' | 'unknown'
      /** which wire event carried it, when a CLI has more than one — codex: item vs turn.failed */
      source?: string
    }
  | { t: 'done'; final: string }

export type BindingStatus = 'unbound' | 'bound' | 'auth_required'

export interface Binding {
  sessionId: string
  agent: AgentId
  foreignId: string | null
  model: string | null
  effort: string
  permission: Permission
  status: BindingStatus
  turns: number
  costUsd: number
  credits: number
  lastSeen: number | null
}

export interface Session {
  id: string
  slug: string
  goal: string
  cwd: string
  lead: AgentId
  status: 'active'
  createdAt: number
  updatedAt: number
}

export interface SpawnPlan {
  cmd: string[]
  env?: Record<string, string>
  cwd?: string
  stdin?: string
}

export interface TurnContext {
  sessionId: string
  slug: string
  cwd: string
  sessionDir: string
  prompt: string
  prelude?: string
  binding: Binding | null
  model?: string
  effort: string
  permission: Permission
  harness?: 'minimal' | 'inherit'
  bin?: string
  lease?: string
  kind?: string
  style?: Style
  delegation?: boolean
}
