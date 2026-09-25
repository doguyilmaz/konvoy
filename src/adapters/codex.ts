import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, oneLine, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

interface Item {
  type?: string
  text?: string
  message?: string
  command?: string
  exit_code?: number | null
  status?: string
  changes?: { path?: string; kind?: string }[]
  server?: string
  tool?: string
  query?: string
}

// codex runs every command through a login shell and reports the wrapper: `/bin/zsh -lc 'cat
// package.json'`. The command inside is what the agent chose; the wrapper is codex's own plumbing.
const SHELL_WRAPPER = /^(?:\/\S*\/)?(?:ba|z|da|k)?sh -l?c '([\s\S]*)'$/

function command(raw: string): string {
  const inner = SHELL_WRAPPER.exec(raw)?.[1]
  return inner && !inner.includes("'") ? inner : raw
}

// codex names each item by its type, and the type is plumbing: `command_execution` reads as a
// parser's word, `Shell` as what happened. Every other CLI konvoy drives names tools this way.
const TOOL_NAME: Record<string, string> = {
  command_execution: 'Shell',
  file_change: 'Edit',
  web_search: 'WebSearch',
  todo_list: 'Plan',
}

function toolName(item: Item): string {
  if (item.type === 'mcp_tool_call' && item.server && item.tool) return `${item.server}.${item.tool}`
  return TOOL_NAME[item.type ?? ''] ?? item.type ?? 'tool'
}

// The subject of each item sits under its own key; model-controlled, so sanitized.
function toolDetail(item: Item): { detail?: string } {
  if (typeof item.command === 'string' && item.command !== '') return { detail: oneLine(command(item.command), 80) }
  const paths = Array.isArray(item.changes) ? item.changes.flatMap((c) => (typeof c?.path === 'string' ? [c.path] : [])) : []
  if (paths.length > 0) {
    const more = paths.length > 1 ? ` +${paths.length - 1} more` : ''
    return { detail: `${oneLine(paths[0]!, 70)}${more}` }
  }
  if (typeof item.query === 'string' && item.query !== '') return { detail: oneLine(item.query, 80) }
  return {}
}

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
      const item = o.item as Item | undefined
      if (!item?.type) return []
      // a started item is only ever a tool: text and reasoning arrive completed
      if (o.type === 'item.started') {
        return item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'error'
          ? []
          : [{ t: 'tool', name: toolName(item), status: 'start', ...toolDetail(item) }]
      }
      if (item.type === 'agent_message') return item.text ? [{ t: 'text', text: item.text }] : []
      if (item.type === 'reasoning') return item.text ? [{ t: 'thinking', text: item.text }] : []
      if (item.type === 'error') {
        const message = item.message ?? ''
        return [{ t: 'error', message, kind: classifyError(message), source: 'item' }]
      }
      // the capture carries exit_code on a completed command_execution: a non-zero one is the
      // difference between "it ran" and "it failed", which the tool line now shows. The other
      // tool items report the same through their status.
      const failed = (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed'
      return [{ t: 'tool', name: toolName(item), status: failed ? 'error' : 'ok', ...toolDetail(item) }]
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
