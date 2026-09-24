import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, oneLine, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

// claude's own mode names, from `claude --help` and its settings reference: `auto` runs
// everything with background safety checks, `dontAsk` would auto-DENY every call that would
// otherwise prompt - the opposite of what a headless turn needs, so konvoy never sends it.
const PERMISSION: Record<Permission, string> = {
  safe: 'manual',
  edit: 'acceptEdits',
  auto: 'auto',
  yolo: 'bypassPermissions',
}

// Every tool names its subject under a different key, and the set is claude's, not konvoy's: a
// key that is not here yields no detail rather than a guess printed as fact.
const DETAIL_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'notebook_path', 'query', 'description'] as const

function toolDetail(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return oneLine(value, 80)
  }
  return undefined
}

// An MCP tool arrives as `mcp__<server>__<tool>`; the server and the tool are what a reader
// recognises, the prefix is claude's namespacing.
function toolName(name: string | undefined): string {
  if (!name) return 'tool'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]}.${mcp[2]}` : name
}

interface AssistantBlock {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
}

// One reading of a complete assistant message. `skip` drops the kinds a turn already received as
// deltas, which the complete message repeats verbatim once each content block closes.
function assistantEvents(message: { content?: unknown[] } | undefined, skip: { text: boolean; thinking: boolean }): KonvoyEvent[] {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const events: KonvoyEvent[] = []
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as AssistantBlock
    if (block.type === 'text' && block.text && !skip.text) events.push({ t: 'text', text: block.text })
    if (block.type === 'thinking' && block.thinking && !skip.thinking) events.push({ t: 'thinking', text: block.thinking })
    if (block.type === 'tool_use') {
      const detail = toolDetail(block.input)
      events.push({ t: 'tool', name: toolName(block.name), status: 'start', ...(detail ? { detail } : {}) })
    }
  }
  return events
}

// Claude Code reports every quota window on every turn (design §27), with a status that turns to
// `allowed_warning` once a threshold is crossed. The binding window is the one it names; the rest
// are context. Read here so a limit is visible before it becomes a failed turn.
function limitEvent(o: Record<string, unknown>): KonvoyEvent[] {
  const info = o.rate_limit_info as
    | { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number }
    | undefined
  if (!info || typeof info.utilization !== 'number' || typeof info.rateLimitType !== 'string') return []
  return [
    {
      t: 'limit',
      window: stripControlChars(info.rateLimitType),
      utilization: info.utilization,
      ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}),
      warning: info.status === 'allowed_warning',
    },
  ]
}

// Everything that is not a token delta reads the same whether or not the turn streams them.
function parseLine(o: Record<string, unknown>, skip: { text: boolean; thinking: boolean }): KonvoyEvent[] {
  if (o.subtype === 'init' && typeof o.session_id === 'string') {
    return [{ t: 'session', foreignId: stripControlChars(o.session_id) }]
  }

  if (o.type === 'assistant') return assistantEvents(o.message as { content?: unknown[] } | undefined, skip)

  // The outcome of a call comes back as a tool_result inside the next `user` message, which is
  // the only place claude reports that a tool failed or was refused. The id it carries is
  // claude's own; konvoy settles the call it has open, so it does not need to match on it.
  if (o.type === 'user') {
    const message = o.message as { content?: unknown[] } | undefined
    const blocks = Array.isArray(message?.content) ? message.content : []
    const events: KonvoyEvent[] = []
    for (const raw of blocks) {
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as { type?: string; is_error?: unknown }
      if (block.type === 'tool_result') events.push({ t: 'tool', name: '', status: block.is_error === true ? 'error' : 'ok' })
    }
    return events
  }

  if (o.type === 'rate_limit_event') return limitEvent(o)

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
}

interface StreamEvent {
  type?: string
  message?: { id?: string }
  content_block?: { type?: string }
  delta?: { type?: string; text?: string; thinking?: string }
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  bin: 'claude',
  supportsPresetSessionId: true,

  turn(ctx: TurnContext): SpawnPlan {
    // --include-partial-messages is what makes the answer arrive token by token rather than one
    // content block at a time: without it a long answer sat invisible until claude finished it
    const cmd = [ctx.bin ?? 'claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
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

  // Each line on its own: a complete assistant message is the whole of what it says, and a delta
  // is ignored because the message that follows it repeats it. Read this way a stream can never
  // double an answer, which is why it is the reading tests and fixtures use.
  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []
    return parseLine(o, { text: false, thinking: false })
  },

  // A turn reads in order, so the text arrives as it is written. The complete message that closes
  // each block repeats what its deltas carried; it is skipped for exactly the messages whose
  // deltas were seen, so a block claude did not stream still reaches the reader.
  parser() {
    let current: string | null = null
    const streamedText = new Set<string>()
    const streamedThinking = new Set<string>()
    return (line: string): KonvoyEvent[] => {
      const o = safeJson(line)
      if (!o) return []
      if (o.type === 'stream_event') {
        const event = o.event as StreamEvent | undefined
        if (event?.type === 'message_start') current = event.message?.id ?? null
        // thinking is usually redacted to an empty block, and the block starting is the only
        // sign of it - which is what the renderer needs to say the agent is thinking
        if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          return [{ t: 'thinking', text: '' }]
        }
        if (event?.type === 'content_block_delta') {
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            if (current) streamedText.add(current)
            return [{ t: 'text', text: delta.text }]
          }
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            if (current) streamedThinking.add(current)
            return [{ t: 'thinking', text: delta.thinking }]
          }
        }
        return []
      }
      const id = o.type === 'assistant' ? ((o.message as { id?: string } | undefined)?.id ?? null) : null
      return parseLine(o, {
        text: id !== null && streamedText.has(id),
        thinking: id !== null && streamedThinking.has(id),
      })
    }
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['claude'] }
    return { cmd: ['claude', '--resume', binding.foreignId] }
  },
}
