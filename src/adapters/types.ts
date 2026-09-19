import type { AgentId, Binding, KonvoyEvent, SpawnPlan, TurnContext } from '../types'

export interface Adapter {
  id: AgentId
  bin: string
  supportsPresetSessionId: boolean
  turn(ctx: TurnContext): SpawnPlan
  parse(line: string): KonvoyEvent[]
  attach(binding: Binding): SpawnPlan
  prepare?(ctx: TurnContext): Promise<void>
  resolveForeignId?(ctx: TurnContext, startedAt: number): Promise<string | null>
}

export function safeJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

export function classifyError(message: string): 'auth' | 'rate' | 'crash' | 'unknown' {
  const m = message.toLowerCase()
  if (m.includes('api key') || m.includes('unauthor') || m.includes('not logged in') || m.includes('login'))
    return 'auth'
  if (m.includes('rate limit') || m.includes('quota') || m.includes('429')) return 'rate'
  return 'unknown'
}
