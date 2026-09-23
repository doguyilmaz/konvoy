import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

// `--approve-for-me` is codex's own words for this: "route approval requests through automatic
// review using the workspace-write sandbox" (codex exec --help, 0.155.1). The sandbox stays.
const SANDBOX: Record<Permission, string[]> = {
  safe: ['-s', 'read-only'],
  edit: ['-s', 'workspace-write'],
  auto: ['-s', 'workspace-write', '--approve-for-me'],
  yolo: ['--dangerously-bypass-approvals-and-sandbox'],
}

export const codexAdapter: Adapter = {
  id: 'codex',
  bin: 'codex',
  supportsPresetSessionId: false,

  turn(ctx: TurnContext): SpawnPlan {
    const cmd = [ctx.bin ?? 'codex', 'exec', '--json', '--skip-git-repo-check']
    if ((ctx.harness ?? 'minimal') === 'minimal') cmd.push('--ignore-user-config')
    if (ctx.model) cmd.push('-m', ctx.model)
    cmd.push('-c', `model_reasoning_effort=${ctx.effort}`)
    cmd.push(...SANDBOX[ctx.permission])
    // `resume` is a subcommand of `exec` with its own small flag set; the flags above belong to
    // `exec` and are only parsed when they come first
    if (ctx.binding?.foreignId) cmd.push('resume', ctx.binding.foreignId)
    cmd.push('--', withPrelude(ctx))
    return { cmd, cwd: ctx.cwd }
  },

  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []

    if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
      return [{ t: 'session', foreignId: stripControlChars(o.thread_id) }]
    }

    if (o.type === 'item.completed') {
      const item = o.item as { type?: string; text?: string; message?: string } | undefined
      if (!item?.type) return []
      if (item.type === 'agent_message') return item.text ? [{ t: 'text', text: item.text }] : []
      if (item.type === 'reasoning') return item.text ? [{ t: 'thinking', text: item.text }] : []
      if (item.type === 'error') {
        const message = item.message ?? ''
        return [{ t: 'error', message, kind: classifyError(message), source: 'item' }]
      }
      return [{ t: 'tool', name: item.type, status: 'ok' }]
    }

    if (o.type === 'turn.completed') {
      const usage = o.usage as { input_tokens?: number; output_tokens?: number } | undefined
      if (!usage) return []
      return [{ t: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }]
    }

    if (o.type === 'turn.failed') {
      const error = o.error as { message?: string } | undefined
      const message = error?.message ?? ''
      return [{ t: 'error', message, kind: classifyError(message), source: 'turn' }]
    }

    return []
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['codex'] }
    return { cmd: ['codex', 'resume', binding.foreignId] }
  },
}
