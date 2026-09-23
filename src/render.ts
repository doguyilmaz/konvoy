import type { KonvoyEvent } from './types'
import { agentPaint, palette } from './style'

export interface RenderDeps {
  /** the agent's own words, verbatim, on stdout */
  out: (text: string) => void
  /** konvoy's chrome: tools, thinking, the footer. stderr, so a pipe gets only the answer */
  err: (text: string) => void
  color: boolean
  tty: boolean
  now: () => number
}

export interface TurnSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
  credits: number
}

export interface TurnRender {
  onEvent: (event: KonvoyEvent) => void
  finish: (summary: TurnSummary) => void
  /** redraw the running tool line one frame on: the caller owns the interval, so tests do not */
  tick: () => void
  /** everything already written to stdout, so the caller does not print the answer twice */
  streamed: () => string
}

const CLEAR = '\r\x1b[2K'

// Braille dots: one cell wide in every terminal font that has them, and a turn that sits on one
// tool for ninety seconds has to look alive rather than hung.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
export const SPINNER_MS = 90

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

// A tool line is only useful with its target: "Bash" says nothing, "Bash  maestro test" says
// what the agent is doing. The glyph is the outcome, which konvoy had no rendering for at all.
function toolLine(name: string, detail: string | undefined, ms: number, glyph: string): string {
  const target = detail ? `  ${detail}` : ''
  return `  ${glyph} ${name}${target}  ${seconds(ms)}`
}

export function turnRender(agent: string, deps: RenderDeps): TurnRender {
  const p = palette(deps.color)
  const paintAgent = agentPaint(deps.color)(agent)
  const started = deps.now()
  let pending: { name: string; detail?: string; at: number } | null = null
  let saidThinking = false
  let streamed = ''
  let frame = 0
  // Three of the four CLIs say something before their first tool call, and the answer goes to
  // stdout while the tool line goes to stderr: without this the two land on one line, which the
  // captured streams render as "I'll read package.json now.  ✓ command_execution".
  let midLine = false
  const breakLine = (): void => {
    if (!midLine) return
    deps.out('\n')
    midLine = false
  }

  // A terminal gets the line the moment the tool starts and the same line rewritten when it
  // settles, so there is something moving while the agent works. A pipe gets the settled line
  // once: a log with half-written lines and escape codes in it is worse than no log.
  const live = (text: string): void => {
    if (!deps.tty) return
    breakLine()
    deps.err(`${CLEAR}${text}`)
  }

  const settle = (glyph: string): void => {
    if (!pending) return
    breakLine()
    const line = toolLine(pending.name, pending.detail, deps.now() - pending.at, glyph)
    deps.err(`${deps.tty ? CLEAR : ''}${p.dim(line)}\n`)
    pending = null
    frame = 0
  }

  // One frame of the running tool line. The caller drives this on an interval, so there is no
  // timer inside the renderer and a test can step it by hand.
  const tick = (): void => {
    if (!deps.tty || !pending) return
    frame = (frame + 1) % FRAMES.length
    deps.err(`${CLEAR}${p.dim(toolLine(pending.name, pending.detail, deps.now() - pending.at, FRAMES[frame]!))}`)
  }

  return {
    onEvent(event) {
      switch (event.t) {
        case 'tool': {
          if (event.status === 'start') {
            settle('·')
            pending = { name: event.name, at: deps.now(), ...(event.detail ? { detail: event.detail } : {}) }
            live(p.dim(toolLine(event.name, event.detail, 0, FRAMES[0]!)))
            return
          }
          // opencode reports a call once, already completed, so there is no open line to settle:
          // seed one from this event - including its detail, or the target is dropped.
          if (!pending) {
            pending = {
              name: event.name || 'tool',
              at: deps.now(),
              ...(event.detail ? { detail: event.detail } : {}),
            }
          }
          settle(event.status === 'error' ? p.red('✗') : p.green('✓'))
          return
        }
        case 'thinking': {
          if (saidThinking || streamed !== '') return
          saidThinking = true
          breakLine()
          deps.err(`${p.dim('  … thinking')}\n`)
          return
        }
        case 'text': {
          settle('·')
          if (event.text === '') return
          streamed += event.text
          midLine = !event.text.endsWith('\n')
          deps.out(event.text)
          return
        }
        default:
          return
      }
    },

    streamed: () => streamed,

    tick,

    // The footer carries what the turn cost and nothing else. A failure is worded once, by
    // decideOutcome in src/commands/send.ts, which also knows the exit code and the login hint.
    finish(summary) {
      settle('·')
      breakLine()
      const spend =
        summary.credits > 0 ? `${summary.credits.toFixed(3)} cr` : summary.costUsd > 0 ? `$${summary.costUsd.toFixed(4)}` : null
      const parts = [paintAgent(agent), seconds(deps.now() - started)]
      if (summary.inputTokens > 0 || summary.outputTokens > 0) {
        parts.push(`${tokens(summary.inputTokens)} in / ${tokens(summary.outputTokens)} out`)
      }
      if (spend) parts.push(spend)
      deps.err(`  ${p.dim(parts.join(' · '))}\n`)
    },
  }
}

// What is left of the turn's final text once the streamed part is accounted for. Every one of
// the four CLIs was captured emitting a final that its own text events already carried in full
// (tests/fixtures/streams), so this is normally empty - but an agent that only reports a final,
// or reports more than it streamed, still has its answer printed instead of swallowed.
export function remainder(final: string, alreadyStreamed: string): string {
  if (alreadyStreamed === '') return final
  if (final === alreadyStreamed || final.trim() === alreadyStreamed.trim()) return ''
  if (final.startsWith(alreadyStreamed)) return final.slice(alreadyStreamed.length)
  return final
}

export interface StatusRow {
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  credits: number
}

// The session total, one dim line above the prompt. A turn's own footer says what that turn
// cost; this says what the session has cost, which is otherwise invisible until you stop and run
// `konvoy usage`. Spend stays in each agent's own unit - dollars and credits are not addable.
export function statusLine(slug: string, rows: readonly StatusRow[], color: boolean): string {
  const total = rows.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      costUsd: acc.costUsd + r.costUsd,
      credits: acc.credits + r.credits,
    }),
    { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 },
  )
  if (total.turns === 0) return ''

  const parts = [slug, `${total.turns} turn${total.turns === 1 ? '' : 's'}`]
  if (total.inputTokens > 0 || total.outputTokens > 0) {
    parts.push(`${tokens(total.inputTokens)} in / ${tokens(total.outputTokens)} out`)
  }
  if (total.costUsd > 0) parts.push(`$${total.costUsd.toFixed(4)}`)
  if (total.credits > 0) parts.push(`${total.credits.toFixed(3)} cr`)
  return palette(color).dim(`  ${parts.join(' · ')}`)
}

export interface BannerFacts {  version: string
  slug: string
  dir: string
  agent: string
  harness: 'minimal' | 'inherit'
  permission: string
}

// Only claude and codex read `harness` (design section 18); saying it about kiro or opencode
// would be describing behavior that was never built.
const HARNESS_AWARE = new Set(['claude', 'codex'])

// A first run that silently drops the user's own setup is how konvoy turned "my Maestro MCP is
// installed" into an agent blaming the user's machine: `minimal` passes
// --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands ("Disable all
// skills", per claude --help) and --setting-sources '' , so none of it is loaded. konvoy knows
// that and said nothing. The same for permission: nobody can answer an approval prompt in a
// headless turn, so a tool that needs one is refused and the turn reads as if it did no work.
export function sessionBanner(facts: BannerFacts, color: boolean): string[] {
  const p = palette(color)
  const lines = [
    `${p.bold('konvoy')} ${p.dim(facts.version)}  ${p.dim('session')} ${facts.slug}  ${p.dim('lead')} ${agentPaint(color)(facts.agent)(facts.agent)}`,
    p.dim(`  ${facts.dir}`),
  ]
  if (facts.harness === 'minimal' && HARNESS_AWARE.has(facts.agent)) {
    lines.push(`${p.yellow('  !')} ${p.dim(`harness minimal: ${facts.agent} runs without your MCP servers, skills or settings files`)}`)
    lines.push(p.dim('    konvoy config set defaults.harness inherit --global   to run it with your own setup'))
  }
  if (facts.permission === 'safe' || facts.permission === 'edit') {
    lines.push(
      `${p.yellow('  !')} ${p.dim(`permission ${facts.permission}: a tool that needs approval is refused, since a headless turn has nobody to ask`)}`,
    )
  }
  return lines
}
