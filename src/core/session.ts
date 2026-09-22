import type { Database } from 'bun:sqlite'
import { oneLine } from '../adapters/types'
import type { AgentId, Session, TurnContext } from '../types'
import type { Config } from '../config/schema'
import type { Adapter } from '../adapters/types'
import { disabledAgent, resolveAgent, resolveRecipient, type AgentSettings } from '../config/load'
import { getAdapter } from '../adapters'
import { clampEffort } from '../adapters/effort'
import { detect, type Detection, type DetectOptions } from './detect'
import {
  acquireLock,
  clearForeignId,
  createSession,
  getBinding,
  getSessionBySlug,
  lastTurnAgent,
  lastTurnId,
  lockOwner,
  releaseLock,
} from '../store/queries'
import { runTurn, type TurnOptions, type TurnResult } from './turn'
import { runGate } from './gate'
import { collectFacts, formatFacts, realFactsDeps } from './facts'
import { buildPrelude, parseEnvelope } from './prelude'
import { sessionDir } from '../paths'

// The prelude carries at most this many recent turns; section 28 caps it so a long session
// cannot let the handover grow until it dominates every turn.
const RECENT_TURNS = 3

// Captured from the real CLIs on 2026-09-19 by resuming an id that does not exist:
//   claude   "No conversation found with session ID <uuid>"
//   codex    "no rollout found for thread id <uuid>"
//   opencode {"type":"error","error":{"message":"Session not found"}}
//   kiro     "error: ACP load_session failed" on stderr, exit 1, no stream events at all
//            (re-measured 2026-09-21 against kiro-cli 2.22.1). The 2026-09-19 note here said
//            kiro reported nothing and silently opened an empty session under whatever id it
//            was handed, and recorded that as an undetectable limit - it is detectable, and
//            leaving the old wording in place is what kept the rebind from firing for kiro.
const STALE =
  /no conversation found|no rollout found|session not found|no such session|unknown session|not found with session|load_session failed/i

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
  detect?: (agent: AgentId, opts: DetectOptions) => Promise<Detection>
  /** base wait between upstream retries; tests that only care about the walk pass 0 */
  upstreamBackoffMs?: number
}

// A chain names an order, not a set: konvoy starts at the requested agent and follows the
// chain forward from wherever that agent sits in it. An agent the chain never mentions has
// nothing configured for it, so it runs alone.
function chainFrom(chain: readonly AgentId[], agent: AgentId): AgentId[] {
  const idx = chain.indexOf(agent)
  return idx === -1 ? [agent] : chain.slice(idx)
}

// a hammered upstream is the last thing to hammer again: a second, times the attempt
const UPSTREAM_BACKOFF_MS = 1000

export async function send(
  deps: SendDeps,
  session: Session,
  agent: AgentId,
  prompt: string,
  opts: TurnOptions = {},
): Promise<TurnResult> {
  const settings = resolveAgent(deps.cfg, agent)
  if (!settings.enabled) throw new Error(disabledAgent(agent))

  const adapterFor = (a: AgentId): Adapter => deps.adapterFor?.(a) ?? getAdapter(a)
  const detectFor = deps.detect ?? detect
  const adapter = adapterFor(agent)
  const detection = await detectFor(agent, { model: settings.model, bin: settings.bin })
  if (!detection.installed) throw new Error(`${agent}: not installed`)

  const timeoutSec = opts.timeoutSec ?? deps.cfg.policy.turnTimeoutSec
  const inherited = Bun.env.KONVOY_LEASE
  const lease = inherited ?? crypto.randomUUID()
  const alreadyHeld = inherited !== undefined && lockOwner(deps.db, session.id) === inherited
  if (!alreadyHeld && !acquireLock(deps.db, session.id, lease)) {
    throw new Error(`session "${session.slug}" is busy - another konvoy turn is running`)
  }

  // Set once withLock() has built the primary prelude - followHandoff needs its own, built
  // fresh after the handing-off turn is recorded, so it is read rather than recomputed here.
  let facts = ''

  try {
    const result = await withLock()
    // The turn just finished writing its own row - runGate reads that row itself to decide
    // whether there is anything for it to judge, so it is always safe to call here.
    const turnId = lastTurnId(deps.db, session.id)
    if (turnId) await runGate(deps.db, deps.cfg, session, turnId)

    const handoff = turnId ? await followHandoff(result, turnId) : null
    if (!handoff) return result

    const handoffTurnId = lastTurnId(deps.db, session.id)
    if (handoffTurnId) await runGate(deps.db, deps.cfg, session, handoffTurnId)
    return handoff
  } finally {
    if (!alreadyHeld) releaseLock(deps.db, session.id, lease)
  }

  // One hop per send: this reads the envelope on the turn `send()` was asked to run, resolves
  // it once, and returns whatever that recipient's own turn produces - including an envelope
  // of its own, which is never fed back in here. A mistaken `to:` pointing back at the sender
  // would otherwise loop until something ran out, and the caller asked for one turn.
  async function followHandoff(result: TurnResult, turnId: string): Promise<TurnResult | null> {
    if (!deps.cfg.delegation.enabled || result.error) return null
    const envelope = parseEnvelope(result.final)
    if (!envelope?.to) return null

    const ranAsAgent = lastTurnAgent(deps.db, session.id) ?? agent
    const recipient = resolveRecipient(deps.cfg, envelope.to)
    if (!recipient) {
      console.error(
        `konvoy: ${ranAsAgent} handed off to "${oneLine(envelope.to, 80)}" - no such agent or role, ${ranAsAgent}'s turn stands`,
      )
      return null
    }

    const recipientSettings = resolveAgent(deps.cfg, recipient)
    const recipientDetection = recipientSettings.enabled
      ? await detectFor(recipient, { model: recipientSettings.model, bin: recipientSettings.bin })
      : { agent: recipient, installed: false, version: null }
    // Reported, not silently dropped - the same rule the failover chain already follows for a
    // disabled or uninstalled member.
    if (!recipientSettings.enabled || !recipientDetection.installed) {
      const why = !recipientSettings.enabled ? 'disabled in config' : 'not installed'
      console.error(
        `konvoy: ${ranAsAgent} handed off to ${recipient}, but ${recipient} is ${why} - ${ranAsAgent}'s turn stands`,
      )
      return null
    }

    console.error(`konvoy: ${ranAsAgent} handed off to ${recipient} - "${oneLine(envelope.task)}"`)

    const recipientEffort = clampEffort(recipientSettings.effort, recipientDetection.efforts)
    // Built fresh, after the handing-off turn was recorded: the prelude built at the top of
    // this send() describes the state before that turn ran - the opposite of what the
    // recipient needs, which is its own cooperative handoff, envelope and all.
    const delegatedPrelude = buildPrelude(deps.db, session, facts, { recent: RECENT_TURNS })
    return runOnce(
      recipient,
      adapterFor(recipient),
      () => ({
        sessionId: session.id,
        slug: session.slug,
        cwd: session.cwd,
        sessionDir: sessionDir(session.cwd, session.slug),
        prompt: envelope.task,
        prelude: delegatedPrelude,
        binding: getBinding(deps.db, session.id, recipient),
        model: recipientSettings.model,
        effort: recipientEffort.value,
        permission: recipientSettings.permission,
        harness: recipientSettings.harness,
        bin: recipientSettings.bin,
        style: recipientSettings.style,
        delegation: deps.cfg.delegation.enabled,
      }),
      turnId,
    )
  }

  // One attempt at one agent: run the turn, and - exactly as before failover existed - rebind
  // a stale foreign session once and retry, never more. This is unchanged by the chain walk;
  // it just now runs once per agent the chain visits instead of once per `send()` call.
  async function runOnce(
    current: AgentId,
    currentAdapter: Adapter,
    ctxBuild: () => TurnContext,
    parentTurnId: string | null,
  ): Promise<TurnResult> {
    const resumedId = getBinding(deps.db, session.id, current)?.foreignId ?? null
    const wasResuming = resumedId != null
    const first = await runTurn(
      { db: deps.db, adapter: currentAdapter },
      { ...ctxBuild(), lease },
      { ...opts, timeoutSec, parentTurnId },
    )

    // "produced nothing" has to mean nothing at all, not merely no text: a turn that ran tool
    // calls edited files and plainly reached a live session, even if it never spoke.
    const producedNothing = first.final.trim() === '' && !first.events.some((e) => e.t === 'tool')
    // Only a crash can be a dead session. An auth failure phrased as "session not found" would
    // otherwise be rebound instead of surfaced, discarding a live session and then failing again
    // identically; a rate limit, a timeout and an interruption say nothing about the session at
    // all. The kinds exist so that failures can be told apart - this is where it matters.
    const recoverable = first.error?.kind === 'crash' || first.error?.kind === 'unknown'
    const stale = first.error != null && recoverable && STALE.test(first.error.message) && producedNothing
    if (!stale || !wasResuming) return first

    // said out loud: a silent rebind looks like continuity and is not
    console.error(`konvoy: ${current} could not load session ${oneLine(resumedId ?? '', 60)} - starting a new one`)
    clearForeignId(deps.db, session.id, current)
    return runTurn(
      { db: deps.db, adapter: currentAdapter },
      { ...ctxBuild(), lease },
      { ...opts, timeoutSec, parentTurnId },
    )
  }

  async function withLock(): Promise<TurnResult> {
    const chain = chainFrom(deps.cfg.failover.chain, agent)
    const upstreamRetries = deps.cfg.failover.upstreamRetries
    let firstTurnId: string | null = null
    let result: TurnResult | undefined

    // Built once for the whole send, not per chain member: recomputing would spend git calls
    // and, worse, let the handover shift between attempts at the same question.
    facts = formatFacts(await collectFacts(realFactsDeps(), deps.db, session))
    const prelude = buildPrelude(deps.db, session, facts, { recent: RECENT_TURNS })

    let blocked: { agent: AgentId; kind: string; message: string } | null = null
    for (let i = 0; i < chain.length; i++) {
      const current = chain[i]!
      const isHead = i === 0

      let currentSettings: AgentSettings
      let currentAdapter: Adapter
      let currentDetection: Detection
      if (isHead) {
        currentSettings = settings
        currentAdapter = adapter
        currentDetection = detection
      } else {
        currentSettings = resolveAgent(deps.cfg, current)
        currentAdapter = adapterFor(current)
        currentDetection = currentSettings.enabled
          ? await detectFor(current, { model: currentSettings.model, bin: currentSettings.bin })
          : { agent: current, installed: false, version: null }
      }
      // A chain member the user hasn't actually set up can't take the handoff - skip it
      // rather than aborting the whole chain, since a later member might still work. Say so:
      // a three-agent chain that quietly becomes a two-agent chain is the user not being told.
      if (!currentSettings.enabled || !currentDetection.installed) {
        if (!isHead) {
          const why = !currentSettings.enabled ? 'disabled in config' : 'not installed'
          console.error(`konvoy: skipping ${current} in the failover chain - ${why}`)
        }
        if (result) continue
        break
      }

      // The move is announced here rather than where the block was detected, because only here
      // is the successor known to be the one that actually runs. Naming chain[i + 1] earlier
      // said "moving to claude" and then ran kiro when claude turned out to be unusable.
      if (blocked) {
        console.error(
          `konvoy: ${blocked.agent} is blocked (${blocked.kind}) - "${oneLine(blocked.message)}" - ${current} is taking over`,
        )
        blocked = null
      }

      const currentEffort = clampEffort(currentSettings.effort, currentDetection.efforts)
      const ctxBuild = (): TurnContext => ({
        sessionId: session.id,
        slug: session.slug,
        cwd: session.cwd,
        sessionDir: sessionDir(session.cwd, session.slug),
        prompt,
        prelude,
        binding: getBinding(deps.db, session.id, current),
        model: currentSettings.model,
        effort: currentEffort.value,
        permission: currentSettings.permission,
        harness: currentSettings.harness,
        bin: currentSettings.bin,
        style: currentSettings.style,
        delegation: deps.cfg.delegation.enabled,
      })

      let retries = 0
      let r: TurnResult
      for (;;) {
        r = await runOnce(current, currentAdapter, ctxBuild, firstTurnId)
        if (firstTurnId === null) firstTurnId = lastTurnId(deps.db, session.id)
        // upstream is transient and usually returns, so it is worth retrying on the same
        // agent - with backoff, since a hammered upstream is the last thing to hammer again.
        if (r.error?.kind === 'upstream' && retries < upstreamRetries) {
          retries++
          await Bun.sleep((deps.upstreamBackoffMs ?? UPSTREAM_BACKOFF_MS) * retries)
          continue
        }
        break
      }
      result = r

      const kind = result.error?.kind
      // rate and auth switch at once - a rate window is hours and an auth failure needs a
      // human, so retrying either is pointless. upstream only reaches here once its retries
      // are spent. crash, timeout and interrupted never switch: the fault travels with the
      // agent, not with the CLI running it, so a second agent would just fail the same way.
      const movable = kind === 'rate' || kind === 'auth' || kind === 'upstream'
      if (!movable) return result

      blocked = { agent: current, kind: kind!, message: result.error!.message }
    }

    return result!
  }
}
