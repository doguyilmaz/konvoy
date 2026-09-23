import type { Binding, KonvoyEvent, SpawnPlan, TurnContext } from '../types'
import { classifyError, oneLine, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

// opencode puts a call's arguments in `state.input`; the keys are its own, so one konvoy does
// not recognise yields no detail rather than a guess rendered as fact.
const DETAIL_KEYS = ['path', 'filePath', 'command', 'pattern', 'url'] as const

function toolDetail(input: Record<string, unknown> | undefined): { detail?: string } {
  if (!input) return {}
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return { detail: oneLine(value, 80) }
  }
  return {}
}

// opencode's own words for what went wrong, preferred over reading its prose. `provider.auth` and
// 403 both mean the agent cannot work until something outside the turn changes, which is what
// konvoy's `auth` kind is for; 429 is the rate window. Anything else it files as a provider problem
// is upstream - reachable but refusing - and a message with no fields falls back to the classifier.
function opencodeErrorKind(
  error: { type?: string; status?: number } | undefined,
  message: string,
): 'auth' | 'rate' | 'upstream' | 'crash' | 'timeout' | 'interrupted' | 'unknown' {
  const kind = error?.type ?? ''
  const status = error?.status
  if (kind.endsWith('.auth') || status === 401 || status === 403) return 'auth'
  if (kind.endsWith('.rate') || status === 429) return 'rate'
  if (kind.startsWith('provider.') || (typeof status === 'number' && status >= 500)) return 'upstream'
  return classifyError(message)
}

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  bin: 'opencode',
  supportsPresetSessionId: false,

  turn(ctx: TurnContext): SpawnPlan {
    const cmd = [ctx.bin ?? 'opencode', 'run', '--standalone', '--format', 'json']
    if (ctx.binding?.foreignId) cmd.push('-s', ctx.binding.foreignId)
    else cmd.push('--title', `konvoy:${ctx.slug}`)
    if (ctx.model) cmd.push('-m', `${ctx.model}#${ctx.effort}`)
    // opencode has one approval switch, `--auto`: "auto-approve permissions that are not
    // explicitly denied" (opencode run --help, 2.0.11). auto and yolo therefore land together.
    if (ctx.permission === 'auto' || ctx.permission === 'yolo') cmd.push('--auto')
    cmd.push('--', withPrelude(ctx))
    // The only config source opencode lets konvoy remove. OPENCODE_CONFIG, _CONTENT and _DIR all
    // ADD a source instead: with every one of them set, `opencode debug config` still resolves
    // ~/.config/opencode/opencode.json, so a minimal opencode turn keeps the user's global
    // config and its MCP servers. Measured against 2.0.11 on 2026-09-22; see design section 18.
    if ((ctx.harness ?? 'minimal') === 'minimal') {
      return {
        cmd,
        cwd: ctx.cwd,
        env: { ...(process.env as Record<string, string>), OPENCODE_CONFIG_PROJECT_DISABLE: '1' },
      }
    }
    return { cmd, cwd: ctx.cwd }
  },

  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []
    const events: KonvoyEvent[] = []
    if (typeof o.sessionID === 'string') events.push({ t: 'session', foreignId: stripControlChars(o.sessionID) })

    const part = o.part as
      | { text?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } }
      | undefined
    switch (o.type) {
      case 'text':
        if (part?.text) events.push({ t: 'text', text: part.text })
        break
      case 'reasoning':
        if (part?.text) events.push({ t: 'thinking', text: part.text })
        break
      case 'tool_use':
        events.push({
          t: 'tool',
          name: part?.tool ?? 'tool',
          status: part?.state?.status === 'error' ? 'error' : 'ok',
          ...toolDetail(part?.state?.input),
        })
        break
      case 'step_finish': {
        const step = o.part as
          | { cost?: number; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } }
          | undefined
        const tokens = step?.tokens
        if (tokens) {
          // opencode's `input` is the uncached remainder, like claude's and unlike codex's -
          // its own `total` is input + output + cache, which is what settles that. It also
          // reports the turn's cost here, on the same part.
          const input = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
          events.push({ t: 'usage', inputTokens: input, outputTokens: tokens.output, costUsd: step?.cost })
        }
        break
      }
      case 'error': {
        const error = o.error as
          | { type?: string; status?: number; message?: string; data?: { message?: string } }
          | undefined
        const message = error?.data?.message ?? error?.message ?? ''
        // opencode names the kind itself (`provider.auth`) and carries the HTTP status. Both are
        // authoritative where konvoy's prose matching is inference: captured 2026-09-23 as
        // `{type: "provider.auth", status: 403}` on a subscription refusal, which a message regex
        // catches only for the exact wording somebody happened to see. The field holds for the
        // refusals nobody has written a pattern for yet, so it decides when it is present.
        events.push({ t: 'error', message, kind: opencodeErrorKind(error, message) })
        break
      }
    }
    return events
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['opencode'] }
    return { cmd: ['opencode', '--session', binding.foreignId] }
  },
}
