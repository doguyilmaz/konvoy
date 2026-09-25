import type { AgentId, Binding, KonvoyEvent, SpawnPlan, TurnContext } from '../types'

export interface Adapter {
  id: AgentId
  bin: string
  supportsPresetSessionId: boolean
  turn(ctx: TurnContext): SpawnPlan
  parse(line: string): KonvoyEvent[]
  /**
   * a parser holding state for one turn, when a stream only makes sense read in order - claude's
   * token deltas repeat in the complete message that follows them. `parse` stays the stateless
   * reading of each line on its own; a turn uses this when it exists.
   */
  parser?(): (line: string) => KonvoyEvent[]
  attach(binding: Binding): SpawnPlan
  prepare?(ctx: TurnContext): Promise<void>
  /** lines a CLI wrote to stderr that the user must see even though the turn succeeded */
  warnings?(stderr: string): string[]
}

// konvoy's own instruction, owned here rather than vendored from any installed skill - a
// user's own such skill is already reachable via `harness: inherit`. It shapes what the user
// reads, not what agents exchange, so it asks for omission, never compression.
export const BRIEF_INSTRUCTION =
  'Lead with the action. Number multi-step work. End with one concrete next step. Skip preamble, recap, and closing pleasantries.'

// konvoy has no model and cannot decide when a turn hands off - only the agent running it
// knows. This instruction is what asks it to say so. A turn not handing work over must emit
// nothing: the envelope costs output tokens only on the turns that actually use it.
export const DELEGATION_INSTRUCTION =
  'If you are handing work to another agent, end your reply with a block like:\n' +
  '<<<konvoy\n' +
  'to: <agent id or role>\n' +
  'task: <imperative, one line>\n' +
  'open: <optional list>\n' +
  'decisions: <optional list>\n' +
  '>>>\n' +
  'If this turn is not handing work over, emit nothing - no block at all.'

// One composition point rather than five: the adapters cannot drift in how they join these,
// and the prelude leads because a stable prefix is what prompt caching discounts. The style
// and delegation instructions trail the prompt for the same reason - they must never join
// the cached prefix.
export function withPrelude(ctx: TurnContext): string {
  const base = ctx.prelude ? `${ctx.prelude}\n\n${ctx.prompt}` : ctx.prompt
  const styled = ctx.style === 'brief' ? `${base}\n\n${BRIEF_INSTRUCTION}` : base
  return ctx.delegation ? `${styled}\n\n${DELEGATION_INSTRUCTION}` : styled
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
// CSI (ESC [ … final), OSC (ESC ] … BEL or ST) and two-byte ESC sequences. Their parameters
// are printable, so dropping only the ESC byte would leave "[2K" behind in an id or a notice.
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripControlChars(value: string): string {
  return value.replace(ANSI, '').replace(/[\x00-\x1f\x7f]/g, '')
}

// For a notice or a table cell: one line, no control bytes, capped - an agent's own words or a
// CLI's stderr can run to kilobytes and can carry escapes that rewrite what konvoy printed.
export function oneLine(value: string, max = 200): string {
  const flat = stripControlChars(value.replace(/\r?\n/g, ' ')).replace(/ {2,}/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// For an agent's final text: keep newlines and tabs, drop every other control byte - CR
// included, which would let a line overwrite the one before it.
export function safeText(value: string): string {
  return value.replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

// Extracted from the four installed binaries on 2026-09-20. Expiry is phrased around
// "session" or "token" - "Cloud gateway session expired", "AWS session has expired",
// "Login token is expired", "MCP OAuth access token is expired" - so requiring the literal
// word "credentials" missed every real expiry. The noun must sit next to the state, or a
// parser's "Unexpected token" and "Invalid token in JSON" read as auth failures.
// An entitlement refusal belongs here rather than in `unknown`: captured from opencode on
// 2026-09-23, "An active OpenCode Go subscription is required to use Go models", which no retry
// and no other prompt can fix. `unknown` would keep a failover chain sitting on that agent. The
// noun must sit next to the state, so ordinary prose about a subscription field stays unclassified.
const AUTH =
  /invalid api key|authentication failed|not authenticated|not (?:logged|signed) in|unauthorized|bad credentials|\b401\b|please run \/?login|(?:credential|token|session)s? (?:are |is |has |have )?(?:expired|revoked|invalid|missing)|token refresh failed|unable to refresh token|(?:active |valid )?subscription (?:is )?(?:required|expired|has expired|needed)|no active subscription/
// `hit your <window> limit` and `rate_limit` are captured verbatim from Claude Code on
// 2026-09-20: "You've hit your weekly limit · resets 7am" and "You've hit your session limit
// · resets 12:40am", both carrying error type rate_limit / HTTP 429. The remaining
// alternatives are conjecture from other vendors' wording and have never been observed here.
// kiro-cli emits no rate-limit prose at all, only AWS exception type names, and those carry
// no separators once lowercased - hence the optional separators below. codex's five-hour
// window is worded "5-hour usage limit", which "usage limit" already covers.
const RATE =
  /hit your \w+ limit|rate[_ ]?limit|quota exceeded|too ?many ?requests|usage limit|weekly limit|\d+[- ]hour (?:usage )?limit|throttl|\b429\b/
// Captured verbatim from opencode's embedded overload classifier, recovered from its binary on
// 2026-09-20: "the service is at capacity", "Overloaded", "temporarily unavailable", "503
// Service Unavailable", "server is busy, try again", "Internal Server Error", and "upstream
// connect error". These describe an API that is reachable but refusing - the one failure worth
// retrying before giving up on an agent, unlike a rate limit (checked first: a message that is
// both rate-limited and mentions 503 is a rate limit, since that window is hours, not seconds).
const UPSTREAM =
  /service is at capacity|overloaded?|temporarily unavailable|\b503\b|server is busy|internal server error|upstream connect error/

export function classifyError(message: string): 'auth' | 'rate' | 'upstream' | 'crash' | 'unknown' {
  const m = message.toLowerCase()
  if (AUTH.test(m)) return 'auth'
  if (RATE.test(m)) return 'rate'
  if (UPSTREAM.test(m)) return 'upstream'
  return 'unknown'
}
