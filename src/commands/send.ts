import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { AgentId } from '../types'
import { requireAgent, requireSession } from './messages'
import { send } from '../core/session'
import { oneLine, safeText } from '../adapters/types'
import { remainder, turnRender, SPINNER_MS } from '../render'
import { colorEnabled } from '../style'
import type { TurnResult } from '../core/turn'

export async function cmdSend(
  db: Database,
  cfg: Config,
  cwd: string,
  agent: string,
  prompt: string,
  slug?: string,
): Promise<number> {
  const target = requireAgent(agent)
  if (!target) return 2
  const session = requireSession(db, cwd, slug)
  if (!session) return 2

  let result: TurnResult
  const view = turnRender(target, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    color: colorEnabled(Bun.env, Boolean(process.stderr.isTTY)),
    tty: Boolean(process.stderr.isTTY),
    now: () => Date.now(),
  })
  // The renderer holds no timer of its own, so the interval lives here, next to the turn it
  // animates. unref so a spinner can never be the reason konvoy stays alive.
  const spinner = setInterval(() => view.tick(), SPINNER_MS)
  spinner.unref?.()
  try {
    result = await send({ db, cfg }, session, target, prompt, { onEvent: view.onEvent })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  } finally {
    clearInterval(spinner)
  }
  view.finish(result)

  const outcome = decideOutcome(target, result)
  // a turn that answered while konvoy was withholding something it did not manage to withhold
  for (const warning of result.warnings) console.error(`konvoy: ${warning}`)
  for (const line of outcome.stderrLines) console.error(line)
  // the answer was streamed as it arrived; only what the stream did not carry is printed here
  if (outcome.stdout !== null) {
    const rest = remainder(outcome.stdout, view.streamed())
    if (rest.trim() !== '') console.log(rest)
  }
  return outcome.code
}

export interface SendOutcome {
  code: number
  stdout: string | null
  stderrLines: string[]
}

// The exit code is decided here, once, from the same two facts turn.ts keeps separate: whether
// output was produced (result.final) and whether the agent is now blocked (result.error.kind).
// A turn that answered and then hit a limit is both successful and blocked - it prints what it
// produced, plus the one line saying the agent can't keep going, and exits 0.
export function decideOutcome(agent: AgentId, result: TurnResult): SendOutcome {
  if (result.error) {
    const blocked = result.error.kind === 'auth' || result.error.kind === 'rate'
    if (blocked && result.final.trim() !== '') {
      const stderrLines = [`${agent} is blocked (${result.error.kind}): ${oneLine(result.error.message)}`]
      if (result.error.kind === 'auth') stderrLines.push(loginHint(agent))
      return { code: 0, stdout: safeText(result.final), stderrLines }
    }
    const stderrLines = [`${agent} failed (${result.error.kind}): ${oneLine(result.error.message)}`]
    if (result.error.kind === 'auth') stderrLines.push(loginHint(agent))
    return { code: 1, stdout: null, stderrLines }
  }
  return { code: 0, stdout: safeText(result.final), stderrLines: [] }
}

export function loginHint(agent: AgentId): string {
  const hints: Record<AgentId, string> = {
    claude: 'run: claude auth',
    codex: 'run: codex login',
    kiro: 'run: kiro-cli login',
    opencode: 'run: opencode providers',
  }
  return hints[agent]
}
