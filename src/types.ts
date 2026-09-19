import type { AgentId, Effort, Permission } from './config/schema'

export type { AgentId, Effort, Permission }

export type KonvoyEvent =
  | { t: 'session'; foreignId: string }
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'tool'; name: string; status: 'start' | 'ok' | 'error' }
  | { t: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; credits?: number }
  | { t: 'error'; message: string; kind: 'auth' | 'rate' | 'crash' | 'timeout' | 'interrupted' | 'unknown' }
  | { t: 'done'; final: string }

export type BindingStatus = 'unbound' | 'bound' | 'auth_required' | 'unavailable'

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
  status: 'active' | 'closed'
  createdAt: number
  updatedAt: number
}

export interface TurnRecord {
  id: string
  sessionId: string
  agent: AgentId
  prompt: string
  final: string
  costUsd: number
  exitCode: number
  error: string | null
  startedAt: number
  endedAt: number
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
  binding: Binding | null
  model?: string
  effort: string
  permission: Permission
  harness?: 'minimal' | 'inherit'
  bin?: string
  lease?: string
  kind?: string
}
