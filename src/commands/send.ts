import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { AgentId } from '../types'
import { agentIds } from '../adapters'
import { currentSession, getSessionBySlug } from '../store/queries'
import { send } from '../core/session'
import type { TurnResult } from '../core/turn'

export async function cmdSend(
  db: Database,
  cfg: Config,
  cwd: string,
  agent: string,
  prompt: string,
  slug?: string,
): Promise<number> {
  if (!agentIds.includes(agent as AgentId)) {
    console.error(`unknown agent "${agent}" — expected one of ${agentIds.join(', ')}`)
    return 2
  }
  const session = slug ? getSessionBySlug(db, slug) : currentSession(db, cwd)
  if (!session) {
    console.error('no konvoy session here — run `konvoy new "<goal>"` first')
    return 2
  }

  let result: TurnResult
  try {
    result = await send({ db, cfg }, session, agent as AgentId, prompt, {
      onEvent: (e) => {
        if (e.t === 'tool') console.error(`  · ${e.name}`)
      },
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  if (result.error) {
    console.error(`${agent} failed (${result.error.kind}): ${result.error.message}`)
    if (result.error.kind === 'auth') console.error(loginHint(agent as AgentId))
    return 1
  }
  console.log(result.final)
  return 0
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
