import type { Binding, KonvoyEvent, SpawnPlan, TurnContext } from '../types'
import { classifyError, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

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

    const part = o.part as { text?: string; tool?: string; state?: { status?: string } } | undefined
    switch (o.type) {
      case 'text':
        if (part?.text) events.push({ t: 'text', text: part.text })
        break
      case 'reasoning':
        if (part?.text) events.push({ t: 'thinking', text: part.text })
        break
      case 'tool_use':
        events.push({ t: 'tool', name: part?.tool ?? 'tool', status: part?.state?.status === 'error' ? 'error' : 'ok' })
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
        const error = o.error as { message?: string; data?: { message?: string } } | undefined
        const message = error?.data?.message ?? error?.message ?? ''
        events.push({ t: 'error', message, kind: classifyError(message) })
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
