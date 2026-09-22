import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

const PERMISSION: Record<Permission, string> = {
  safe: 'manual',
  edit: 'acceptEdits',
  yolo: 'bypassPermissions',
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  bin: 'claude',
  supportsPresetSessionId: true,

  turn(ctx: TurnContext): SpawnPlan {
    const cmd = [ctx.bin ?? 'claude', '-p', '--output-format', 'stream-json', '--verbose']
    if (ctx.binding?.foreignId) cmd.push('--resume', ctx.binding.foreignId)
    else cmd.push('--session-id', ctx.sessionId)
    if (ctx.model) cmd.push('--model', ctx.model)
    cmd.push('--effort', ctx.effort)
    cmd.push('--permission-mode', PERMISSION[ctx.permission])
    if ((ctx.harness ?? 'minimal') === 'minimal') {
      cmd.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '')
    }
    cmd.push('--', withPrelude(ctx))
    return { cmd, cwd: ctx.cwd }
  },

  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []

    if (o.subtype === 'init' && typeof o.session_id === 'string') {
      return [{ t: 'session', foreignId: stripControlChars(o.session_id) }]
    }

    if (o.type === 'assistant') {
      const message = o.message as { content?: unknown[] } | undefined
      const blocks = Array.isArray(message?.content) ? message.content : []
      const events: KonvoyEvent[] = []
      for (const raw of blocks) {
        if (typeof raw !== 'object' || raw === null) continue
        const block = raw as { type?: string; text?: string; thinking?: string; name?: string }
        if (block.type === 'text' && block.text) events.push({ t: 'text', text: block.text })
        if (block.type === 'thinking' && block.thinking) events.push({ t: 'thinking', text: block.thinking })
        if (block.type === 'tool_use') events.push({ t: 'tool', name: block.name ?? 'tool', status: 'start' })
      }
      return events
    }

    if (o.type === 'result') {
      const text = typeof o.result === 'string' ? o.result : ''
      // a result can be is_error with no text at all - claude puts the reason on stderr then, and
      // an invented placeholder here would stand in the way of turn.ts reading it
      if (o.is_error) return [{ t: 'error', message: text, kind: classifyError(text) }]
      const usage = o.usage as
        | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
        | undefined
      // claude splits input across three fields and input_tokens holds only the uncached
      // remainder, so it reads near zero on a cached turn. codex's input_tokens already
      // contains its cached count; summing here is what puts both agents in one unit.
      const input = usage
        ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
        : undefined
      return [
        {
          t: 'usage',
          inputTokens: input,
          outputTokens: usage?.output_tokens,
          costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
        },
        { t: 'done', final: text },
      ]
    }

    return []
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['claude'] }
    return { cmd: ['claude', '--resume', binding.foreignId] }
  },
}
