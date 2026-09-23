import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, oneLine, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

// codex names the subject of a shell item in `command`; model-controlled, so sanitized.
const toolDetail = (item: { command?: string }): { detail?: string } =>
  typeof item.command === 'string' && item.command !== '' ? { detail: oneLine(item.command, 80) } : {}

// `--approve-for-me` is codex's own words for this: "route approval requests through automatic
// review using the workspace-write sandbox" (codex exec --help, 0.156.1). It therefore sets that
// sandbox ITSELF and is mutually exclusive with `-s`: passing both makes codex exit 2 with
// "the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'". Measured on a
// live turn 2026-09-23; verify:claims cannot catch it, since each flag does exist on its own.
const SANDBOX: Record<Permission, string[]> = {
  safe: ['-s', 'read-only'],
  edit: ['-s', 'workspace-write'],
  auto: ['--approve-for-me'],
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

    if (o.type === 'item.started' || o.type === 'item.completed') {
      const item = o.item as
        | { type?: string; text?: string; message?: string; command?: string; exit_code?: number | null }
        | undefined
      if (!item?.type) return []
      // a started item is only ever a tool: text and reasoning arrive completed
      if (o.type === 'item.started') {
        return item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'error'
          ? []
          : [{ t: 'tool', name: item.type, status: 'start', ...toolDetail(item) }]
      }
      if (item.type === 'agent_message') return item.text ? [{ t: 'text', text: item.text }] : []
      if (item.type === 'reasoning') return item.text ? [{ t: 'thinking', text: item.text }] : []
      if (item.type === 'error') {
        const message = item.message ?? ''
        return [{ t: 'error', message, kind: classifyError(message), source: 'item' }]
      }
      // the capture carries exit_code on a completed command_execution: a non-zero one is the
      // difference between "it ran" and "it failed", which the tool line now shows
      const failed = typeof item.exit_code === 'number' && item.exit_code !== 0
      return [{ t: 'tool', name: item.type, status: failed ? 'error' : 'ok', ...toolDetail(item) }]
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

    // A bare top-level error line. The 2026-09-23 rate-limit capture carries it immediately before
    // turn.failed with the same wording, so reading it changes nothing there - but a stream that
    // ever sends it WITHOUT turn.failed would otherwise be read as a wordless non-zero exit, which
    // turn.ts classifies as a crash. A crash keeps the failover chain on an agent that is rate
    // limited for hours, so the line that says why is worth reading.
    if (o.type === 'error') {
      const message = typeof o.message === 'string' ? o.message : ''
      return [{ t: 'error', message, kind: classifyError(message), source: 'stream' }]
    }

    return []
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['codex'] }
    return { cmd: ['codex', 'resume', binding.foreignId] }
  },
}
