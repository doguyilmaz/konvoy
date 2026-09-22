import type { Database } from 'bun:sqlite'
import type { AgentId, Effort, Permission, Session, SpawnPlan } from '../types'
import { agentIds, getAdapter } from '../adapters'
import { getBinding, upsertBinding } from '../store/queries'
import { requireSession } from './messages'
import { oneLine } from '../adapters/types'
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

// Bind a session the user started outside konvoy - the id a CLI prints for its own resume
// command. The same shape check as every stream-captured id applies at the write path; the
// binding is only reported as adopted if it actually holds the id.
export function adoptForeignSession(
  db: Database,
  session: Session,
  agent: AgentId,
  foreignId: string,
  settings: { effort: Effort; permission: Permission },
): boolean {
  upsertBinding(db, { sessionId: session.id, agent, foreignId, effort: settings.effort, permission: settings.permission })
  return getBinding(db, session.id, agent)?.foreignId === foreignId
}

export interface AttachOptions {
  slug?: string
  bin?: string
  /** a session id from the CLI itself, adopted into this konvoy session before opening */
  id?: string
  effort?: Effort
  permission?: Permission
}

export async function cmdAttach(db: Database, cwd: string, agent: string, opts: AttachOptions = {}): Promise<number> {
  const { slug, bin } = opts
  if (!agentIds.includes(agent as AgentId)) {
    console.error(`unknown agent "${agent}" - expected one of ${agentIds.join(', ')}`)
    return 2
  }
  const session = requireSession(db, cwd, slug)
  if (!session) return 2

  const detection = await detect(agent as AgentId, { bin })
  if (!detection.installed) {
    console.error(`${agent}: not installed`)
    return 2
  }

  if (opts.id) {
    const adopted = adoptForeignSession(db, session, agent as AgentId, opts.id, {
      effort: opts.effort ?? 'high',
      permission: opts.permission ?? 'edit',
    })
    if (!adopted) {
      console.error(`konvoy: ${agent} not bound - the id was refused; nothing opened`)
      return 2
    }
    console.error(`konvoy: ${agent} bound to session ${oneLine(opts.id, 60)} - the next turn resumes it; opening it now`)
  }

  const plan = attachPlan(db, session, agent as AgentId, bin)
  const proc = Bun.spawn(plan.cmd, { cwd: plan.cwd, stdio: ['inherit', 'inherit', 'inherit'] })
  return await proc.exited
}
