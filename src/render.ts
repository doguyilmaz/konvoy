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
  /** everything already written to stdout, so the caller does not print the answer twice */
  streamed: () => string
}

const CLEAR = '\r\x1b[2K'

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

  // A terminal gets the line the moment the tool starts and the same line rewritten when it
  // settles, so there is something moving while the agent works. A pipe gets the settled line
  // once: a log with half-written lines and escape codes in it is worse than no log.
  const live = (text: string): void => {
    if (deps.tty) deps.err(`${CLEAR}${text}`)
  }

  const settle = (glyph: string): void => {
    if (!pending) return
    const line = toolLine(pending.name, pending.detail, deps.now() - pending.at, glyph)
    deps.err(`${deps.tty ? CLEAR : ''}${p.dim(line)}\n`)
    pending = null
  }

  return {
    onEvent(event) {
      switch (event.t) {
        case 'tool': {
          if (event.status === 'start') {
            settle('·')
            pending = { name: event.name, at: deps.now(), ...(event.detail ? { detail: event.detail } : {}) }
            live(p.dim(toolLine(event.name, event.detail, 0, '·')))
            return
          }
          if (!pending) pending = { name: event.name || 'tool', at: deps.now() }
          settle(event.status === 'error' ? p.red('✗') : p.green('✓'))
          return
        }
        case 'thinking': {
          if (saidThinking || streamed !== '') return
          saidThinking = true
          deps.err(`${p.dim('  … thinking')}\n`)
          return
        }
        case 'text': {
          settle('·')
          if (event.text === '') return
          streamed += event.text
          deps.out(event.text)
          return
        }
        default:
          return
      }
    },

    streamed: () => streamed,

    // The footer carries what the turn cost and nothing else. A failure is worded once, by
    // decideOutcome in src/commands/send.ts, which also knows the exit code and the login hint.
    finish(summary) {
      settle('·')
      if (streamed !== '' && !streamed.endsWith('\n')) deps.out('\n')
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

export interface BannerFacts {
  version: string
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
  if (facts.permission !== 'yolo') {
    lines.push(
      `${p.yellow('  !')} ${p.dim(`permission ${facts.permission}: a tool that needs approval is refused, since a headless turn has nobody to ask`)}`,
    )
  }
  return lines
}
