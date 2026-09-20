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

// One composition point rather than four: the adapters cannot drift in how they join these,
// and the prelude leads because a stable prefix is what prompt caching discounts.
export function withPrelude(ctx: TurnContext): string {
  return ctx.prelude ? `${ctx.prelude}\n\n${ctx.prompt}` : ctx.prompt
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

// foreignId, the model a CLI echoes back, and the auth detail string are konvoy's own metadata,
// read from a CLI's stdout and later printed to the terminal or stored. Control bytes (OSC/SGR
// escapes) have no legitimate use there, so they are stripped at the parse boundary rather than
// wherever the value later gets printed.
export function stripControlChars(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '')
}

// Extracted from the four installed binaries on 2026-09-20. Expiry is phrased around
// "session" or "token" — "Cloud gateway session expired", "AWS session has expired",
// "Login token is expired", "MCP OAuth access token is expired" — so requiring the literal
// word "credentials" missed every real expiry. The noun must sit next to the state, or a
// parser's "Unexpected token" and "Invalid token in JSON" read as auth failures.
const AUTH =
  /invalid api key|authentication failed|not authenticated|not (?:logged|signed) in|unauthorized|bad credentials|\b401\b|please run \/?login|(?:credential|token|session)s? (?:are |is |has |have )?(?:expired|revoked|invalid|missing)|token refresh failed|unable to refresh token/
// `hit your <window> limit` and `rate_limit` are captured verbatim from Claude Code on
// 2026-09-20: "You've hit your weekly limit · resets 7am" and "You've hit your session limit
// · resets 12:40am", both carrying error type rate_limit / HTTP 429. The remaining
// alternatives are conjecture from other vendors' wording and have never been observed here.
// kiro-cli emits no rate-limit prose at all, only AWS exception type names, and those carry
// no separators once lowercased — hence the optional separators below. codex's five-hour
// window is worded "5-hour usage limit", which "usage limit" already covers.
const RATE =
  /hit your \w+ limit|rate[_ ]?limit|quota exceeded|too ?many ?requests|usage limit|weekly limit|\d+[- ]hour (?:usage )?limit|throttl|\b429\b/
// Captured verbatim from opencode's embedded overload classifier, recovered from its binary on
// 2026-09-20: "the service is at capacity", "Overloaded", "temporarily unavailable", "503
// Service Unavailable", "server is busy, try again", "Internal Server Error", and "upstream
// connect error". These describe an API that is reachable but refusing — the one failure worth
// retrying before giving up on an agent, unlike a rate limit (checked first: a message that is
// both rate-limited and mentions 503 is a rate limit, since that window is hours, not seconds).
const UPSTREAM =
  /at capacity|overloaded?|temporarily unavailable|\b503\b|server is busy|internal server error|upstream connect error/

export function classifyError(message: string): 'auth' | 'rate' | 'upstream' | 'crash' | 'unknown' {
  const m = message.toLowerCase()
  if (AUTH.test(m)) return 'auth'
  if (RATE.test(m)) return 'rate'
  if (UPSTREAM.test(m)) return 'upstream'
  return 'unknown'
}
