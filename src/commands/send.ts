import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { AgentId } from '../types'
import { requireAgent, requireSession } from './messages'
import { send } from '../core/session'
import { onExit } from '../core/children'
import { errorLines, safeText } from '../adapters/types'
import { remainder, turnRender, SPINNER_MS } from '../render'
import { colorLevel, palette } from '../style'
import { HIDE_CURSOR, SHOW_CURSOR } from '../term'
import type { TurnResult } from '../core/turn'

export interface SendOptions {
  /** stops the turn without stopping konvoy: the REPL's Esc and Ctrl-C */
  signal?: AbortSignal
  /** how to stop it, shown beside the spinner */
  hint?: string
  /** run from the REPL: next steps name its commands instead of a shell's */
  interactive?: boolean
}

export async function cmdSend(
  db: Database,
  cfg: Config,
  cwd: string,
  agent: string,
  prompt: string,
  slug?: string,
  opts: SendOptions = {},
): Promise<number> {
  const target = requireAgent(agent)
  if (!target) return 2
  const session = requireSession(db, cwd, slug)
  if (!session) return 2

  const tty = Boolean(process.stderr.isTTY)
  const level = colorLevel(Bun.env, tty)
  let result: TurnResult
  const view = turnRender(target, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    color: level,
    tty,
    outTty: Boolean(process.stdout.isTTY),
    now: () => Date.now(),
    columns: () => process.stderr.columns ?? process.stdout.columns ?? 80,
    rows: () => process.stderr.rows ?? process.stdout.rows ?? 24,
    hint: opts.hint ?? (tty ? 'ctrl+c to interrupt' : undefined),
  })
  // The renderer holds no timer of its own, so the interval lives here, next to the turn it
  // animates. unref so a spinner can never be the reason konvoy stays alive.
  const spinner = setInterval(() => view.tick(), SPINNER_MS)
  spinner.unref?.()

  // A notice printed mid-turn - a failover, a rebind, a handoff - would land at the end of the
  // spinner line and leave the live region misplaced for every redraw after it. Each one takes the
  // live region down first; the next frame puts it back underneath.
  const original = { error: console.error, warn: console.warn }
  console.error = (...args: unknown[]) => {
    view.suspend()
    original.error(...args)
  }
  console.warn = (...args: unknown[]) => {
    view.suspend()
    original.warn(...args)
  }
  // a turn on a terminal hides the cursor under the spinner, and a konvoy killed mid-turn must
  // still give it back
  const restoreCursor = (): void => {
    if (tty) process.stderr.write(SHOW_CURSOR)
  }
  if (tty) process.stderr.write(HIDE_CURSOR)
  const forget = onExit(restoreCursor)
  try {
    result = await send({ db, cfg }, session, target, prompt, { onEvent: view.onEvent, signal: opts.signal })
  } catch (error) {
    view.suspend()
    console.error = original.error
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  } finally {
    clearInterval(spinner)
    console.error = original.error
    console.warn = original.warn
    restoreCursor()
    forget()
  }

  const outcome = decideOutcome(target, result, { interactive: opts.interactive })
  // the answer was streamed as it arrived; only what the stream did not carry is added, and it
  // goes through the renderer so a terminal shows it rendered and ahead of the footer
  if (outcome.stdout !== null) {
    const rest = remainder(outcome.stdout, view.streamed())
    if (rest.trim() !== '') view.onEvent({ t: 'text', text: rest.endsWith('\n') ? rest : `${rest}\n` })
  }
  view.finish(result)

  const p = palette(level)
  // a turn that answered while konvoy was withholding something it did not manage to withhold
  for (const warning of result.warnings) console.error(level > 0 ? `${p.yellow('  !')} ${warning}` : `konvoy: ${warning}`)
  for (const [i, line] of outcome.stderrLines.entries()) {
    if (level === 0) console.error(line)
    else if (result.error?.kind === 'interrupted') console.error(p.dim(`  ${line}`))
    else if (i > 0) console.error(p.dim(`    ${line}`))
    else console.error(outcome.code === 0 ? `${p.yellow('  !')} ${line}` : `${p.red('  ✗')} ${line}`)
  }
  return outcome.code
}

export interface SendOutcome {
  code: number
  stdout: string | null
  stderrLines: string[]
}

// A CLI that words a failure as its reply: claude answers a rate limit with "You've hit your weekly
// limit · resets 7am" as the turn's text AND as its error. Printed as an answer and then again as
// the error, it read twice; an answer that says only what the error says is not an answer.
function onlyTheError(final: string, message: string): boolean {
  const words = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase()
  const f = words(final)
  return f !== '' && (f === words(message) || words(message).includes(f))
}

// A model name the CLI refused. Each words it its own way; these are the ones seen or documented:
// opencode "Invalid model reference: opus-5-5" (2.0.11), codex "model ... does not exist", agy's
// print mode listing the valid ones when --model cannot be resolved.
const BAD_MODEL = /invalid model|unknown model|model not found|not a valid model|model \S+ (?:does not exist|is not (?:available|supported))|could not resolve (?:the )?model/i

/** what to do next, said where it can be done: inside konvoy, or from a shell */
function nextSteps(agent: AgentId, error: NonNullable<TurnResult['error']>, interactive: boolean): string[] {
  if (error.kind === 'auth') {
    return interactive ? [`sign in inside ${agent} itself: /attach ${agent}, then come back`, loginHint(agent)] : [loginHint(agent)]
  }
  if (error.kind === 'rate') {
    return [
      interactive
        ? 'shift+tab to another agent, or /use konvoy to move on by itself when one runs out'
        : `konvoy send <another agent> …, or set failover.chain to move on by itself`,
    ]
  }
  if (BAD_MODEL.test(error.message)) {
    return [interactive ? `/model to pick one ${agent} offers` : `konvoy config set agents.${agent}.model <name> - see what ${agent} offers in konvoy's /model`]
  }
  return []
}

// The exit code is decided here, once, from the same two facts turn.ts keeps separate: whether
// output was produced (result.final) and whether the agent is now blocked (result.error.kind).
// A turn that answered and then hit a limit is both successful and blocked - it prints what it
// produced, plus the one line saying the agent can't keep going, and exits 0.
export function decideOutcome(agent: AgentId, result: TurnResult, opts: { interactive?: boolean } = {}): SendOutcome {
  if (!result.error) return { code: 0, stdout: safeText(result.final), stderrLines: [] }
  const error = result.error
  // the person stopped it: what streamed stays on screen, and nothing about it is a failure
  if (error.kind === 'interrupted') {
    return { code: 130, stdout: null, stderrLines: [`interrupted - ${agent} stopped where it was`] }
  }
  const blocked = error.kind === 'auth' || error.kind === 'rate'
  const [said, ...links] = errorLines(error.message)
  const lines = [`${agent} ${blocked ? 'is blocked' : 'failed'} (${error.kind}): ${said}`, ...links, ...nextSteps(agent, error, opts.interactive ?? false)]
  const answered = result.final.trim() !== '' && !onlyTheError(result.final, error.message)
  if (blocked && answered) return { code: 0, stdout: safeText(result.final), stderrLines: lines }
  return { code: 1, stdout: null, stderrLines: lines }
}

export function loginHint(agent: AgentId): string {
  const hints: Record<AgentId, string> = {
    claude: 'run: claude auth',
    codex: 'run: codex login',
    kiro: 'run: kiro-cli login',
    opencode: 'run: opencode providers',
    antigravity: 'run: agy and sign in (it has no auth subcommand)',
  }
  return hints[agent]
}
