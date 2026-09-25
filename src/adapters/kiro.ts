import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, oneLine, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

// kiro-cli 2.23.0 `chat --help` has only `--trust-tools=<list>` and `--trust-all-tools`: no
// automatic-review mode to map `auto` onto. It therefore trusts exactly what `edit` trusts -
// promoting it to `--trust-all-tools` would make `auto` mean yolo on one agent out of five.
const TRUST: Record<Permission, string> = {
  safe: '--trust-tools=',
  edit: '--trust-tools=fs_read,fs_write,grep,glob,execute_bash',
  auto: '--trust-tools=fs_read,fs_write,grep,glob,execute_bash',
  yolo: '--trust-all-tools',
}

// kiro's harness lever is an agent profile, and `--agent` takes a NAME: names resolve from
// `<cwd>/.kiro/agents` or `$KIRO_HOME/agents` only (kiro-cli 2.23.0, `kiro-cli agent list`), a
// path is not loaded, and KIRO_HOME cannot be moved because kiro's conversation store lives
// under it. So konvoy writes one file it owns, in the project it is already working in.
const MINIMAL_AGENT = 'konvoy-minimal'

const agentPath = (cwd: string): string => `${cwd}/.kiro/agents/${MINIMAL_AGENT}.json`

// The three fields that make it minimal: kiro_default, materialised with
// `agent create -f kiro_default`, carries the user's MCP servers, `includeMcpJson: true`, and
// resources for AGENTS.md, README.md, every skill glob and the global steering directory.
const minimalProfile = JSON.stringify(
  {
    name: MINIMAL_AGENT,
    description: 'konvoy minimal harness: no MCP servers, no mcp.json merge, no resources',
    prompt: null,
    mcpServers: {},
    tools: ['*'],
    toolAliases: {},
    allowedTools: [],
    resources: [],
    toolsSettings: {},
    includeMcpJson: false,
    model: null,
  },
  null,
  2,
)

// kiro warns and carries on when `--agent` names something it cannot load, so a stderr line is
// the only evidence konvoy is not running the harness it thinks it is. The turn's answer stands,
// but it is reported with the turn: silently running the user's whole setup under the name
// "minimal" is the one outcome worse than saying so.
const AGENT_FAILED = /failed to set agent '([^']*)'/

interface ToolUpdate {
  title?: string
  kind?: string
  status?: string
  locations?: { path?: unknown }[]
  rawInput?: { command?: unknown }
}

// kiro speaks ACP, where a call carries a `kind` from a fixed vocabulary and the files it touched
// under `locations`. The title is prose ("Reading package.json:1"); the kind and the path are the
// same two facts every other CLI's tool line shows, so they are what konvoy shows for kiro too.
const KIND: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Shell',
  fetch: 'Fetch',
  think: 'Think',
}

function toolLabel(update: ToolUpdate): { name: string; detail?: string } {
  const name = KIND[update.kind ?? '']
  const path = update.locations?.find((l) => typeof l?.path === 'string')?.path as string | undefined
  const command = typeof update.rawInput?.command === 'string' ? update.rawInput.command : undefined
  const subject = path ?? command
  if (name) return { name, ...(subject ? { detail: oneLine(subject, 80) } : update.title ? { detail: oneLine(update.title, 80) } : {}) }
  return { name: update.title ? oneLine(update.title, 60) : 'tool', ...(subject ? { detail: oneLine(subject, 80) } : {}) }
}

export const kiroAdapter: Adapter = {
  id: 'kiro',
  bin: 'kiro-cli',
  supportsPresetSessionId: false,

  async prepare(ctx: TurnContext): Promise<void> {
    if ((ctx.harness ?? 'minimal') !== 'minimal') return
    await Bun.write(agentPath(ctx.cwd), minimalProfile)
  },

  turn(ctx: TurnContext): SpawnPlan {
    const cmd = [ctx.bin ?? 'kiro-cli', 'chat', '--no-interactive', '--output-format', 'stream-json']
    if (ctx.binding?.foreignId) cmd.push('--resume-id', ctx.binding.foreignId)
    if (ctx.model) cmd.push('--model', ctx.model)
    if ((ctx.harness ?? 'minimal') === 'minimal') cmd.push('--agent', MINIMAL_AGENT)
    cmd.push('--effort', ctx.effort, TRUST[ctx.permission], '--', withPrelude(ctx))
    return { cmd, cwd: ctx.cwd }
  },

  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []
    const data = o.data as Record<string, unknown> | undefined
    if (!data) return []

    const events: KonvoyEvent[] = []
    if (typeof data.sessionId === 'string') events.push({ t: 'session', foreignId: stripControlChars(data.sessionId) })

    if (o.type === 'sessionUpdate') {
      const update = data.update as (ToolUpdate & { sessionUpdate?: string; content?: { text?: string } }) | undefined
      const text = update?.content?.text
      switch (update?.sessionUpdate) {
        case 'agent_message_chunk':
          if (text) events.push({ t: 'text', text })
          break
        case 'agent_thought_chunk':
          if (text) events.push({ t: 'thinking', text })
          break
        case 'tool_call':
          events.push({ t: 'tool', ...toolLabel(update), status: 'start' })
          break
        case 'tool_call_update':
          events.push({ t: 'tool', ...toolLabel(update), status: update.status === 'failed' ? 'error' : 'ok' })
          break
      }
    }

    if (o.type === 'metadata') {
      const metering = Array.isArray(data.meteringUsage)
        ? (data.meteringUsage as { value?: number; unit?: string }[])
        : undefined
      const credits = metering?.find((m) => m.unit === 'credit')?.value
      if (typeof credits === 'number') events.push({ t: 'usage', credits })
    }

    if (o.type === 'runFinished') {
      if (data.status === 'success') {
        // finalText comes with a finalTextTruncated flag - kiro truncates it. Only an untruncated
        // copy is authoritative; otherwise no done is emitted and the streamed chunks stand.
        if (typeof data.finalText === 'string' && data.finalTextTruncated !== true) events.push({ t: 'done', final: data.finalText })
      } else {
        const message = typeof data.stopReason === 'string' ? data.stopReason : ''
        events.push({ t: 'error', message, kind: classifyError(message) })
      }
    }

    return events
  },

  // The turn still answered, so it is not failed and its output stands; what the user must not
  // be left to discover is that it answered with their whole configuration loaded.
  warnings(stderr: string): string[] {
    const failed = AGENT_FAILED.exec(stderr)
    if (!failed) return []
    return [
      `kiro did not load the agent profile "${failed[1]}", so this turn ran with your own kiro configuration, not the minimal harness`,
    ]
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['kiro-cli', 'chat'] }
    return { cmd: ['kiro-cli', 'chat', '--resume-id', binding.foreignId] }
  },
}
