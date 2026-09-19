import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, safeJson, type Adapter } from './types'

const TRUST: Record<Permission, string> = {
  safe: '--trust-tools=',
  edit: '--trust-tools=fs_read,fs_write,grep,glob,execute_bash',
  yolo: '--trust-all-tools',
}

export const kiroAdapter: Adapter = {
  id: 'kiro',
  bin: 'kiro-cli',
  supportsPresetSessionId: false,

  turn(ctx: TurnContext): SpawnPlan {
    const cmd = [ctx.bin ?? 'kiro-cli', 'chat', '--no-interactive', '--output-format', 'stream-json']
    if (ctx.binding?.foreignId) cmd.push('--resume-id', ctx.binding.foreignId)
    if (ctx.model) cmd.push('--model', ctx.model)
    cmd.push('--effort', ctx.effort, TRUST[ctx.permission], '--', ctx.prompt)
    return { cmd, cwd: ctx.cwd }
  },

  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []
    const data = o.data as Record<string, unknown> | undefined
    if (!data) return []

    const events: KonvoyEvent[] = []
    if (typeof data.sessionId === 'string') events.push({ t: 'session', foreignId: data.sessionId })

    if (o.type === 'sessionUpdate') {
      const update = data.update as
        | { sessionUpdate?: string; content?: { text?: string }; title?: string; status?: string }
        | undefined
      const text = update?.content?.text
      switch (update?.sessionUpdate) {
        case 'agent_message_chunk':
          if (text) events.push({ t: 'text', text })
          break
        case 'agent_thought_chunk':
          if (text) events.push({ t: 'thinking', text })
          break
        case 'tool_call':
          events.push({ t: 'tool', name: update.title ?? 'tool', status: 'start' })
          break
        case 'tool_call_update':
          events.push({ t: 'tool', name: update.title ?? 'tool', status: update.status === 'failed' ? 'error' : 'ok' })
          break
      }
    }

    if (o.type === 'metadata') {
      const metering = data.meteringUsage as { value?: number; unit?: string }[] | undefined
      const credits = metering?.find((m) => m.unit === 'credit')?.value
      if (typeof credits === 'number') events.push({ t: 'usage', credits })
    }

    if (o.type === 'runFinished') {
      if (data.status === 'success') {
        events.push({ t: 'done', final: typeof data.finalText === 'string' ? data.finalText : '' })
      } else {
        const message = typeof data.stopReason === 'string' ? data.stopReason : 'run failed'
        events.push({ t: 'error', message, kind: classifyError(message) })
      }
    }

    return events
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['kiro-cli', 'chat'] }
    return { cmd: ['kiro-cli', 'chat', '--resume-id', binding.foreignId] }
  },
}
