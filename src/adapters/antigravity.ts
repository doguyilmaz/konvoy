import type { Binding, KonvoyEvent, Permission, SpawnPlan, TurnContext } from '../types'
import { classifyError, oneLine, safeJson, stripControlChars, withPrelude, type Adapter } from './types'

// `agy --help` (1.2.9) offers `--mode accept-edits|plan` and `--dangerously-skip-permissions`, and
// nothing between them: there is no automatic-review mode, so `auto` trusts exactly what `edit`
// trusts. Promoting it to skipping every permission would make one agent of five mean yolo at a
// level the other four keep bounded - the same call kiro's row already makes.
const MODE: Record<Permission, string[]> = {
  safe: ['--mode', 'plan'],
  edit: ['--mode', 'accept-edits'],
  auto: ['--mode', 'accept-edits'],
  yolo: ['--dangerously-skip-permissions'],
}

// agy names the subject of a tool call inside `tool_info.parameters`, under keys that are its own:
// the captured `run_command` call uses `CommandLine`, capitalised. A key konvoy has no entry for
// yields no target rather than a guess rendered as fact.
const DETAIL_KEYS = ['CommandLine', 'command', 'path', 'file_path', 'AbsolutePath', 'pattern', 'url', 'query'] as const

function toolDetail(input: unknown): { detail?: string } {
  if (typeof input !== 'object' || input === null) return {}
  const record = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return { detail: oneLine(value, 80) }
  }
  return {}
}

// Two things agy reports outside its own stream, both captured 2026-09-23, and both a SILENT loss
// if konvoy ignores them. A resume whose conversation is gone does not fail: agy warns on stderr
// and starts a NEW conversation, so the turn succeeds having forgotten everything. And a tool that
// needs a permission nobody can grant is auto-denied, which can leave a SUCCESS with no answer.
const CONVERSATION_GONE = /conversation "([^"]+)" not found/
const DENIED_TOOL = /a tool required the "([^"]+)" permission that headless mode cannot prompt for/

interface StepUpdate {
  state?: string
  step_type?: string
  text_delta?: string
  tool_name?: string
  tool_info?: { parameters?: unknown; error?: { type?: string; message?: string } }
}

interface Result {
  status?: string
  response?: string
  error?: string
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number }
}

export const antigravityAdapter: Adapter = {
  id: 'antigravity',
  bin: 'agy',
  // agy assigns its own conversation id and reports it in the `init` event; konvoy stores that in
  // the binding and resumes with `--conversation <id>`, which its own error text documents as one
  // of `{number}`, `{uuid}` or `latest`. Only claude accepts a caller-chosen id.
  supportsPresetSessionId: false,

  turn(ctx: TurnContext): SpawnPlan {
    const cmd = [ctx.bin ?? 'agy', '--print', '--output-format', 'stream-json']
    if (ctx.binding?.foreignId) cmd.push('--conversation', ctx.binding.foreignId)
    if (ctx.model) cmd.push('--model', ctx.model)
    cmd.push('--effort', ctx.effort)
    cmd.push(...MODE[ctx.permission])
    // agy's own words for this: "Disable slash command and skill expansion in print mode"
    if ((ctx.harness ?? 'minimal') === 'minimal') cmd.push('--disable-slash-commands')
    cmd.push(withPrelude(ctx))
    return { cmd, cwd: ctx.cwd }
  },

  parse(line: string): KonvoyEvent[] {
    const o = safeJson(line)
    if (!o) return []

    if (o.event === 'init' && typeof o.conversation_id === 'string') {
      return [{ t: 'session', foreignId: stripControlChars(o.conversation_id) }]
    }

    if (o.event === 'step_update') {
      const step = o.step_update as StepUpdate | undefined
      if (!step) return []
      const events: KonvoyEvent[] = []

      // konvoy already holds the prompt it sent; echoing the user_input step back would duplicate
      // it into the transcript and into `final`.
      if (step.step_type === 'agent_response' && step.text_delta) {
        events.push({ t: 'text', text: step.text_delta })
      }
      // The captured step_type is `tool`, and its arguments and error live under `tool_info`.
      // A guess of `tool_call` with a `tool_input` field was wrong on both counts, which is why
      // tests/provider-contract.test.ts demands a real capture reach every branch.
      if (step.step_type === 'tool') {
        const failed = step.state === 'ERROR' || step.tool_info?.error !== undefined
        const status = failed ? 'error' : step.state === 'DONE' ? 'ok' : 'start'
        events.push({
          t: 'tool',
          name: step.tool_name ?? 'tool',
          status,
          ...toolDetail(step.tool_info?.parameters),
        })
      }
      return events
    }

    if (o.event === 'result') {
      const result = o.result as Result | undefined
      if (!result) return []
      const events: KonvoyEvent[] = []
      const usage = result.usage
      if (usage) {
        // The arithmetic in the real captures settles what these fields mean: input 12864 +
        // output 1514 === total 14378, and thinking 1513 is a SUBSET of output, not an addition
        // to input. Adding thinking to the input count would both double-count it and file model
        // output as context sent - the unit confusion design section 18 had to be corrected for.
        // Cache reads ARE context that was sent, so they join the input side.
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0)
        events.push({ t: 'usage', inputTokens: input, outputTokens: usage.output_tokens ?? 0 })
      }
      if (result.status === 'SUCCESS') {
        events.push({ t: 'done', final: result.response ?? '' })
        return events
      }
      // An ERROR result with an empty response is a failed turn, not a silent one. agy puts the
      // reason on stderr (a real capture: "Eligibility check failed: UNAVAILABLE (code 503)"),
      // which turn.ts reads when the exit code is non-zero, so a wordless error here is expected.
      const message = result.error ?? ''
      events.push({ t: 'error', message, kind: classifyError(message) })
      return events
    }

    return []
  },

  attach(binding: Binding): SpawnPlan {
    if (!binding.foreignId) return { cmd: ['agy'] }
    return { cmd: ['agy', '--conversation', binding.foreignId] }
  },

  // The turn exits 0 and reports SUCCESS, so neither of these is a failure; what the user must not
  // be left to work out is why the answer is empty, or why the agent has forgotten the session.
  warnings(stderr: string): string[] {
    const out: string[] = []
    const gone = CONVERSATION_GONE.exec(stderr)
    if (gone) {
      out.push(
        `antigravity could not find conversation ${oneLine(gone[1] ?? '', 60)} and started a new one, so this turn began with no memory of the session`,
      )
    }
    const denied = DENIED_TOOL.exec(stderr)
    if (denied) {
      out.push(
        `antigravity auto-denied a tool needing the "${denied[1]}" permission, because a headless turn has nobody to prompt - raise this agent's permission to yolo, or allow it in agy's own settings`,
      )
    }
    return out
  },
}
