import type { KonvoyEvent } from './types'
import { agentPaint, palette, type ColorLevel, type Paint } from './style'
import { markdownRenderer, type MarkdownRenderer } from './markdown'
import { eraseRows, stringWidth, stripAnsi, truncate, wrappedRows } from './term'
import { oneLine, safeText } from './adapters/types'

export interface RenderDeps {
  /** the agent's own words on stdout: verbatim to a pipe, rendered on a terminal */
  out: (text: string) => void
  /** konvoy's chrome: tools, thinking, the footer. stderr, so a pipe gets only the answer */
  err: (text: string) => void
  color: boolean | ColorLevel
  /** stderr is a terminal: the live region (spinner, running tool, the line being written) */
  tty: boolean
  /** stdout is a terminal: the answer is rendered as Markdown a line at a time */
  outTty?: boolean
  now: () => number
  columns?: () => number
  rows?: () => number
  /** how to stop the turn, shown beside the spinner: "esc to interrupt", "ctrl+c to interrupt" */
  hint?: string
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
  /** redraw the live region one frame on: the caller owns the interval, so tests do not */
  tick: () => void
  /** everything the agent said, verbatim, so the caller does not print the answer twice */
  streamed: () => string
  /** take the live region off the screen before something else writes to the terminal */
  suspend: () => void
}

// Braille dots for a running tool, one cell wide in every terminal font that has them: a turn that
// sits on one tool for ninety seconds has to look alive rather than hung. The status line, which
// is the agent itself working, turns a star the way the agents' own CLIs do.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const STARS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'] as const
export const SPINNER_MS = 90
const PREVIEW_MS = 30

// DEC mode 2026: the terminal holds a redraw until it is complete, so erasing and repainting the
// live region never shows as a flicker. A terminal that does not know the mode ignores it.
const SYNC_ON = '\x1b[?2026h'
const SYNC_OFF = '\x1b[?2026l'

/** a turn's duration: tenths under a minute, where the number moves; minutes after, where it does not */
export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m ${String(secs).padStart(2, '0')}s`
}

// the spinner's clock, which ticks in whole seconds: a tenth that changes ten times a second is noise
function elapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return duration(ms)
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// A tool line is only useful with its target: "Bash" says nothing, "Bash  maestro test" says
// what the agent is doing. The glyph is the outcome, which konvoy had no rendering for at all.
// The plain form is fixed - a log or a test reads it byte for byte - and colour only paints it.
function toolLine(p: ReturnType<typeof palette>, name: string, detail: string | undefined, ms: number, glyph: string, running: boolean): string {
  const target = detail ? `  ${detail}` : ''
  if (running) return `  ${glyph} ${p.dim(`${name}${target}  ${duration(ms)}`)}`
  return `  ${glyph} ${p.bold(name)}${target}  ${p.dim(duration(ms))}`
}

// The first line of a thought, without the Markdown codex wraps its reasoning titles in: enough to
// say what the agent is thinking about, never a transcript of the reasoning.
function thoughtTitle(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  return oneLine(first.replace(/^\*\*(.*)\*\*$/, '$1').replace(/[*_`#]/g, ''), 120)
}

const WINDOW: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
}

function resetClock(epochSeconds: number, now: number): string {
  const at = new Date(epochSeconds * 1000)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  if (at.getTime() - now < 20 * 60 * 60 * 1000) return hhmm
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm}`
}

/** the one line a quota window earns once it is close to the edge */
export function limitNotice(agent: string, limit: Extract<KonvoyEvent, { t: 'limit' }>, now: number): string {
  const name = WINDOW[limit.window] ?? limit.window.replace(/_/g, ' ')
  const reset = limit.resetsAt ? ` · resets ${resetClock(limit.resetsAt, now)}` : ''
  return `${agent} has used ${Math.round(limit.utilization * 100)}% of its ${name} limit${reset}`
}

// a window worth mentioning: the CLI said so itself, or it is nine tenths spent
const LIMIT_WARN = 0.9

export function turnRender(agent: string, deps: RenderDeps): TurnRender {
  const p = palette(deps.color)
  const paintAgent = agentPaint(deps.color)(agent)
  const colored = deps.color !== false && deps.color !== 0
  const started = deps.now()
  const outTty = deps.outTty === true
  const columns = (): number => Math.max(20, deps.columns?.() ?? 80)
  // the live region is redrawn by moving up over it; taller than the screen and there is no
  // "up" left to move, so it is kept well inside it
  const maxRows = (): number => Math.max(2, Math.min(12, (deps.rows?.() ?? 24) - 6))
  const md: MarkdownRenderer | null = outTty && colored
    ? markdownRenderer({ p, accent: paintAgent, code: codePaint(deps.color) }, columns)
    : null

  let pending: { name: string; detail?: string; at: number } | null = null
  let saidThinking = false
  let activity: 'working' | 'thinking' = 'working'
  let thought = ''
  let streamed = ''
  let frame = 0
  let running = true
  let wrote = false
  let liveRows = 0
  // when the live region was last drawn: a streamed line updates it at most this often, since a
  // repaint per token redraws the whole region for a change of a few cells
  let paintedAt = Number.NEGATIVE_INFINITY
  // the line of the answer still being written, held back on a terminal until it is complete so
  // it can be rendered as a whole line; shown meanwhile in the live region
  let partial = ''
  const limits = new Map<string, Extract<KonvoyEvent, { t: 'limit' }>>()

  // Three of the four CLIs say something before their first tool call, and the answer goes to
  // stdout while the tool line goes to stderr: without this the two land on one line, which the
  // captured streams render as "I'll read package.json now.  ✓ command_execution".
  let midLine = false
  const breakLine = (): void => {
    if (!midLine) return
    deps.out('\n')
    midLine = false
  }

  const statusLine = (): string => {
    const glyph = STARS[frame % STARS.length]!
    const label = activity === 'thinking' ? 'Thinking' : 'Working'
    const tail = [elapsed(deps.now() - started), deps.hint].filter(Boolean).join(' · ')
    const head = `${glyph} ${label}…`
    const room = columns() - 1 - stringWidth(head) - stringWidth(tail) - 4
    const title = activity === 'thinking' ? thoughtTitle(thought) : ''
    const about = title && room > 8 ? ` ${truncate(title, room)}` : ''
    return `${paintAgent(head)}${p.dim(`${about} (${tail})`)}`
  }

  const previewLines = (): string[] => {
    if (!outTty || partial === '') return []
    const cols = columns()
    let raw = partial.replace(/\t/g, '    ')
    const budget = maxRows() * cols - 2
    if (stringWidth(raw) > budget) {
      // only the tail of a very long line fits; the whole of it arrives when it is complete
      let tail = ''
      let width = 0
      for (const char of [...raw].reverse()) {
        width += stringWidth(char)
        if (width > budget - 1) break
        tail = char + tail
      }
      raw = `…${tail}`
    }
    return [md ? md.preview(raw) : raw]
  }

  const liveLines = (): string[] => {
    if (!running) return []
    const lines = previewLines()
    if (pending) lines.push(toolLine(p, pending.name, pending.detail, deps.now() - pending.at, paintAgent(FRAMES[frame % FRAMES.length]!), true))
    else lines.push(statusLine())
    return lines
  }

  // Every write to the terminal goes through here: take the live region down, write what is now
  // permanent, put the live region back underneath it. A pipe has no live region, so it gets the
  // permanent writes and nothing else.
  const paint = (commit?: () => void): void => {
    if (!deps.tty) {
      commit?.()
      return
    }
    deps.err(`${SYNC_ON}${eraseRows(liveRows)}`)
    liveRows = 0
    paintedAt = deps.now()
    commit?.()
    const lines = liveLines()
    if (lines.length > 0) {
      const cols = columns()
      // the status and tool lines are cut to one row; only the answer preview may wrap
      const fitted = lines.map((l, i) => (i === lines.length - 1 && stringWidth(l) >= cols ? cutPainted(l, cols - 1) : l))
      deps.err(fitted.join('\n'))
      liveRows = fitted.reduce((n, l) => n + wrappedRows(stripAnsi(l), cols), 0)
    }
    deps.err(SYNC_OFF)
  }

  const settle = (glyph: string): void => {
    if (!pending) return
    const line = toolLine(p, pending.name, pending.detail, deps.now() - pending.at, glyph, false)
    pending = null
    wrote = true
    paint(() => {
      flushPartial()
      breakLine()
      deps.err(`${line}\n`)
    })
  }

  // the held-back line of the answer, committed as it stands: something other than text is about
  // to be written below it, so it cannot wait for its newline any longer
  const flushPartial = (): void => {
    if (partial === '') return
    const line = partial
    partial = ''
    deps.out(`${md ? md.line(line) : line}\n`)
  }

  // The agent's words are model output, and model output can carry what it read: an escape sequence
  // in a file it echoed would clear the screen, retitle the window or write the clipboard (OSC 52).
  // The final text always went through safeText; the stream written ahead of it did not.
  const text = (raw: string): void => {
    const chunk = safeText(raw)
    if (chunk === '') return
    streamed += chunk
    wrote = true
    if (!outTty) {
      // a pipe or a file: the agent's bytes, exactly as they arrive
      paint(() => {
        midLine = !chunk.endsWith('\n')
        deps.out(chunk)
      })
      return
    }
    const lines = (partial + chunk).split('\n')
    partial = lines.pop() ?? ''
    if (lines.length === 0) {
      // the spinner's own tick shows the rest within one frame
      if (deps.now() - paintedAt >= PREVIEW_MS) paint()
      return
    }
    paint(() => {
      for (const line of lines) deps.out(`${md ? md.line(line) : line}\n`)
    })
  }

  return {
    onEvent(event) {
      switch (event.t) {
        case 'tool': {
          if (event.status === 'start') {
            settle('·')
            activity = 'working'
            pending = { name: event.name, at: deps.now(), ...(event.detail ? { detail: event.detail } : {}) }
            paint(() => {
              flushPartial()
              breakLine()
            })
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
          // a new run of thinking starts a new thought; deltas within one run accumulate
          if (activity !== 'thinking') thought = ''
          activity = 'thinking'
          thought += event.text
          if (deps.tty) {
            paint()
            return
          }
          if (saidThinking || streamed !== '') return
          saidThinking = true
          breakLine()
          deps.err(`${p.dim('  … thinking')}\n`)
          return
        }
        case 'text': {
          settle('·')
          if (event.text === '') return
          activity = 'working'
          text(event.text)
          return
        }
        case 'limit': {
          limits.set(event.window, event)
          return
        }
        default:
          return
      }
    },

    streamed: () => streamed,

    tick() {
      if (!deps.tty || !running) return
      frame++
      paint()
    },

    suspend() {
      if (!deps.tty || liveRows === 0) return
      deps.err(`${eraseRows(liveRows)}`)
      liveRows = 0
    },

    // The footer carries what the turn cost and nothing else. A failure is worded once, by
    // decideOutcome in src/commands/send.ts, which also knows the exit code and the login hint.
    finish(summary) {
      settle('·')
      running = false
      paint(() => {
        flushPartial()
        breakLine()
      })
      const spend =
        summary.credits > 0 ? `${summary.credits.toFixed(3)} cr` : summary.costUsd > 0 ? `$${summary.costUsd.toFixed(4)}` : null
      const parts = [paintAgent(agent), duration(deps.now() - started)]
      if (summary.inputTokens > 0 || summary.outputTokens > 0) {
        parts.push(`${tokens(summary.inputTokens)} in / ${tokens(summary.outputTokens)} out`)
      }
      if (spend) parts.push(spend)
      // on a terminal the footer stands apart from the answer it closes; a log keeps it adjacent
      deps.err(`${deps.tty && wrote ? '\n' : ''}  ${p.dim(parts.join(' · '))}\n`)
      for (const limit of limits.values()) {
        if (!limit.warning && limit.utilization < LIMIT_WARN) continue
        deps.err(`${p.yellow('  !')} ${p.dim(limitNotice(agent, limit, deps.now()))}\n`)
      }
    },
  }
}

// cut a painted line to `max` cells without breaking an escape sequence, and close what it opened
function cutPainted(line: string, max: number): string {
  let out = ''
  let width = 0
  for (let i = 0; i < line.length; ) {
    const esc = /^\x1b\[[0-?]*[ -\/]*[@-~]/.exec(line.slice(i))
    if (esc) {
      out += esc[0]
      i += esc[0].length
      continue
    }
    const char = String.fromCodePoint(line.codePointAt(i)!)
    const w = stringWidth(char)
    if (width + w > max) break
    out += char
    width += w
    i += char.length
  }
  return line.includes('\x1b[') ? `${out}\x1b[0m` : out
}

// code in an answer reads as code: a muted blue on a terminal with the colours for it
function codePaint(level: boolean | ColorLevel): Paint {
  if (level === 2 || level === 3) {
    return level === 3 ? (t) => `\x1b[38;2;137;180;250m${t}\x1b[39m` : (t) => `\x1b[38;5;111m${t}\x1b[39m`
  }
  return palette(level).cyan
}

// What is left of the turn's final text once the streamed part is accounted for. Every one of
// the five CLIs was captured emitting a final that its own text events already carried in full
// (tests/fixtures/streams), so this is normally empty - but an agent that only reports a final,
// or reports more than it streamed, still has its answer printed instead of swallowed.
//
// claude's final is only its LAST message, so a turn that spoke before a tool call streamed more
// than its final holds: the final then sits at the end of the stream, not at its start, and
// reprinting it doubled the answer's closing paragraph.
export function remainder(final: string, alreadyStreamed: string): string {
  if (alreadyStreamed === '') return final
  if (final === alreadyStreamed || final.trim() === alreadyStreamed.trim()) return ''
  if (final.trim() !== '' && alreadyStreamed.includes(final.trim())) return ''
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
export function statusLine(slug: string, rows: readonly StatusRow[], color: boolean | ColorLevel): string {
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

export interface BannerFacts {
  version: string
  slug: string
  dir: string
  agent: string
  harness: 'minimal' | 'inherit'
  permission: string
  model?: string
  effort?: string
  goal?: string
  /** who is riding along: installed agents are filled, missing ones hollow */
  roster?: readonly { agent: string; ready: boolean }[]
  /** a session reopened: who answered last, how long ago, and what they were asked */
  last?: { agent: string; ago: string; prompt: string }
  columns?: number
}

// Only claude and codex read `harness` (design section 18); saying it about kiro or opencode
// would be describing behavior that was never built.
const HARNESS_AWARE = new Set(['claude', 'codex'])

// The first thing a session shows, in the shape every agent CLI opens with: a box naming the tool,
// the session and who is listening. Then the two things konvoy knows it is withholding.
// A first run that silently drops the user's own setup is how konvoy turned "my Maestro MCP is
// installed" into an agent blaming the user's machine: `minimal` passes
// --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands ("Disable all
// skills", per claude --help) and --setting-sources '' , so none of it is loaded. konvoy knows
// that and said nothing. The same for permission: nobody can answer an approval prompt in a
// headless turn, so a tool that needs one is refused and the turn reads as if it did no work.
export function sessionBanner(facts: BannerFacts, color: boolean | ColorLevel): string[] {
  const p = palette(color)
  const paint = agentPaint(color)
  const tuned = [facts.model, facts.effort, facts.permission].filter(Boolean).join(' · ')
  const rows: [string, string][] = [
    ['session', facts.goal ? `${facts.slug} ${p.dim(`· ${facts.goal}`)}` : facts.slug],
    ['agent', `${paint(facts.agent)(facts.agent)}${tuned ? p.dim(` · ${tuned}`) : ''}`],
  ]
  if (facts.roster && facts.roster.length > 0) {
    rows.push([
      'convoy',
      facts.roster.map((r) => (r.ready ? `${paint(r.agent)('●')} ${r.agent}` : p.dim(`○ ${r.agent}`))).join('  '),
    ])
  }
  rows.push(['dir', p.dim(facts.dir)])
  if (facts.last) rows.push(['last', `${paint(facts.last.agent)(facts.last.agent)} ${p.dim(`${facts.last.ago} ›`)} ${facts.last.prompt}`])

  const title = `${paint(facts.agent)('✻')} ${p.bold('konvoy')} ${p.dim(facts.version)}`
  const body = [title, '', ...rows.map(([k, v]) => `  ${p.dim(k.padEnd(8))}${v}`)]
  const limit = Math.max(40, (facts.columns ?? 100) - 4)
  const inner = Math.min(limit, Math.max(...body.map((l) => stringWidth(l)))) + 2
  const edge = (l: string, r: string): string => p.dim(`${l}${'─'.repeat(inner)}${r}`)
  const lines = [
    edge('╭', '╮'),
    ...body.map((l) => {
      const fitted = stringWidth(l) > inner - 2 ? cutPainted(l, inner - 3) + p.dim('…') : l
      return `${p.dim('│')} ${fitted}${' '.repeat(Math.max(0, inner - 2 - stringWidth(fitted)))} ${p.dim('│')}`
    }),
    edge('╰', '╯'),
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
