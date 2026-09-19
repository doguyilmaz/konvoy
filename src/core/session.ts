import type { Database } from 'bun:sqlite'
import type { AgentId, Session, TurnContext } from '../types'
import type { Config } from '../config/schema'
import type { Adapter } from '../adapters/types'
import { resolveAgent } from '../config/load'
import { getAdapter } from '../adapters'
import { clampEffort } from '../adapters/effort'
import { detect } from './detect'
import {
  acquireLock,
  clearForeignId,
  createSession,
  getBinding,
  getSessionBySlug,
  lockOwner,
  releaseLock,
} from '../store/queries'
import { runTurn, type TurnOptions, type TurnResult } from './turn'
import { sessionDir } from '../paths'

const STALE = /no conversation found|session not found|no such session|unknown session|not found with session/i

export function slugify(goal: string): string {
  const base = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return base || 'session'
}

export function uniqueSlug(db: Database, base: string): string {
  if (!getSessionBySlug(db, base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!getSessionBySlug(db, candidate)) return candidate
  }
  throw new Error(`cannot find a free slug for ${base}`)
}

export function newSession(
  db: Database,
  input: { cwd: string; goal: string; slug?: string; lead: AgentId },
): Session {
  const slug = uniqueSlug(db, input.slug ? slugify(input.slug) : slugify(input.goal))
  return createSession(db, { slug, goal: input.goal, cwd: input.cwd, lead: input.lead })
}

export interface SendDeps {
  db: Database
  cfg: Config
  adapterFor?: (agent: AgentId) => Adapter
}

export async function send(
  deps: SendDeps,
  session: Session,
  agent: AgentId,
  prompt: string,
  opts: TurnOptions = {},
): Promise<TurnResult> {
  const settings = resolveAgent(deps.cfg, agent)
  if (!settings.enabled) throw new Error(`${agent} is disabled in this konvoy config`)

  const adapter = deps.adapterFor?.(agent) ?? getAdapter(agent)
  const detection = await detect(agent, settings.model)
  const effort = clampEffort(settings.effort, detection.efforts)
  const build = (): TurnContext => ({
    sessionId: session.id,
    slug: session.slug,
    cwd: session.cwd,
    sessionDir: sessionDir(session.cwd, session.slug),
    prompt,
    binding: getBinding(deps.db, session.id, agent),
    model: settings.model,
    effort: effort.value,
    permission: settings.permission,
    harness: settings.harness,
    bin: settings.bin,
  })

  const timeoutSec = opts.timeoutSec ?? deps.cfg.policy.turnTimeoutSec
  const inherited = Bun.env.KONVOY_LEASE
  const lease = inherited ?? crypto.randomUUID()
  const alreadyHeld = inherited !== undefined && lockOwner(deps.db, session.id) === inherited
  if (!alreadyHeld && !acquireLock(deps.db, session.id, lease)) {
    throw new Error(`session "${session.slug}" is busy — another konvoy turn is running`)
  }

  try {
    return await withLock()
  } finally {
    if (!alreadyHeld) releaseLock(deps.db, session.id, lease)
  }

  async function withLock(): Promise<TurnResult> {
    const wasResuming = getBinding(deps.db, session.id, agent)?.foreignId != null
    const first = await runTurn({ db: deps.db, adapter }, { ...build(), lease }, { ...opts, timeoutSec })

    const stale =
      first.error != null && STALE.test(first.error.message) && first.final.trim() === ''
    if (!stale || !wasResuming) return first

    clearForeignId(deps.db, session.id, agent)
    return runTurn({ db: deps.db, adapter }, { ...build(), lease }, { ...opts, timeoutSec })
  }
}
