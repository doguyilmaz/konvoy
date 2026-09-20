import type { Database } from 'bun:sqlite'
import type { AgentId, Session, SpawnPlan } from '../types'
import { agentIds, getAdapter } from '../adapters'
import { currentSession, getBinding, getSessionBySlug } from '../store/queries'
import { detect } from '../core/detect'

export function attachPlan(db: Database, session: Session, agent: AgentId, bin?: string): SpawnPlan {
  const binding = getBinding(db, session.id, agent)
  const plan = getAdapter(agent).attach(
    binding ?? {
      sessionId: session.id,
      agent,
      foreignId: null,
      model: null,
      effort: 'high',
      permission: 'edit',
      status: 'unbound',
      turns: 0,
      costUsd: 0,
      credits: 0,
      lastSeen: null,
    },
  )
  const cmd = bin ? [bin, ...plan.cmd.slice(1)] : plan.cmd
  return { ...plan, cmd, cwd: session.cwd }
}

export async function cmdAttach(
  db: Database,
  cwd: string,
  agent: string,
  slug?: string,
  bin?: string,
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

  const detection = await detect(agent as AgentId, { bin })
  if (!detection.installed) {
    console.error(`${agent}: not installed`)
    return 2
  }

  const plan = attachPlan(db, session, agent as AgentId, bin)
  const proc = Bun.spawn(plan.cmd, { cwd: plan.cwd, stdio: ['inherit', 'inherit', 'inherit'] })
  return await proc.exited
}
