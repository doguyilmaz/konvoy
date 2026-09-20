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

const AUTH =
  /invalid api key|authentication failed|not authenticated|not logged in|unauthorized|\b401\b|please run \/?login|credentials? (?:are )?(?:invalid|missing|expired)/
// `hit your <window> limit` and `rate_limit` are captured verbatim from Claude Code on
// 2026-09-20: "You've hit your weekly limit · resets 7am" and "You've hit your session limit
// · resets 12:40am", both carrying error type rate_limit / HTTP 429. The remaining
// alternatives are conjecture from other vendors' wording and have never been observed here.
const RATE =
  /hit your \w+ limit|rate[_ ]limit|quota exceeded|too many requests|usage limit|weekly limit|\d+[- ]hour limit|\b429\b/

export function classifyError(message: string): 'auth' | 'rate' | 'crash' | 'unknown' {
  const m = message.toLowerCase()
  if (AUTH.test(m)) return 'auth'
  if (RATE.test(m)) return 'rate'
  return 'unknown'
}
