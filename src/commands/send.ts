import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { AgentId } from '../types'
import { requireAgent, requireSession } from './messages'
import { send } from '../core/session'
import { oneLine, safeText } from '../adapters/types'
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
  try {
    result = await send({ db, cfg }, session, target, prompt, {
      onEvent: (e) => {
        if (e.t === 'tool') console.error(`  · ${oneLine(e.name, 120)}`)
      },
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const outcome = decideOutcome(target, result)
  for (const line of outcome.stderrLines) console.error(line)
  if (outcome.stdout !== null) console.log(outcome.stdout)
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
