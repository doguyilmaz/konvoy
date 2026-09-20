import type { Database } from 'bun:sqlite'
import type { AgentId, Binding, Permission, Session } from '../types'
import type { ModelUsage } from '../pricing'

const now = () => Date.now()
const id = () => crypto.randomUUID()

export function createSession(
  db: Database,
  input: { slug: string; goal: string; cwd: string; lead: AgentId },
): Session {
  const row: Session = {
    id: id(),
    slug: input.slug,
    goal: input.goal,
    cwd: input.cwd,
    lead: input.lead,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  }
  db.query(
    `INSERT INTO session (id, slug, goal, cwd, lead, status, created_at, updated_at, updated_seq)
     VALUES ($id, $slug, $goal, $cwd, $lead, $status, $createdAt, $updatedAt,
             (SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM session))`,
  ).run({
    id: row.id,
    slug: row.slug,
    goal: row.goal,
    cwd: row.cwd,
    lead: row.lead,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  return row
}

const toSession = (r: Record<string, unknown> | null): Session | null =>
  r
    ? {
        id: r.id as string,
        slug: r.slug as string,
        goal: r.goal as string,
        cwd: r.cwd as string,
        lead: r.lead as AgentId,
        status: r.status as Session['status'],
        createdAt: r.created_at as number,
        updatedAt: r.updated_at as number,
      }
    : null

export function getSessionBySlug(db: Database, slug: string): Session | null {
  return toSession(db.query('SELECT * FROM session WHERE slug = $slug').get({ slug }) as never)
}

export function listSessions(db: Database): Session[] {
  const rows = db.query('SELECT * FROM session ORDER BY created_at DESC, rowid DESC').all() as never[]
  return rows.map((r) => toSession(r)!).filter(Boolean)
}

export function currentSession(db: Database, cwd: string): Session | null {
  return toSession(
    db.query('SELECT * FROM session WHERE cwd = $cwd AND status = $status ORDER BY updated_seq DESC LIMIT 1').get({
      cwd,
      status: 'active',
    }) as never,
  )
}

export function touchSession(db: Database, id: string): void {
  db.query(
    `UPDATE session SET updated_at = $now,
       updated_seq = (SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM session)
     WHERE id = $id`,
  ).run({ id, now: now() })
}

export function deleteSession(db: Database, id: string): void {
  db.transaction(() => {
    db.query('DELETE FROM event WHERE turn_id IN (SELECT id FROM turn WHERE session_id = $id)').run({ id })
    db.query('DELETE FROM turn WHERE session_id = $id').run({ id })
    db.query('DELETE FROM binding WHERE session_id = $id').run({ id })
    db.query('DELETE FROM lock WHERE session_id = $id').run({ id })
    db.query('DELETE FROM session WHERE id = $id').run({ id })
  })()
}

export function upsertBinding(
  db: Database,
  input: {
    sessionId: string
    agent: AgentId
    foreignId: string | null
    effort: string
    permission: Permission
    model?: string | null
  },
): void {
  db.query(
    `INSERT INTO binding (session_id, agent, foreign_id, model, effort, permission, status, last_seen)
     VALUES ($sessionId, $agent, $foreignId, $model, $effort, $permission, $status, $lastSeen)
     ON CONFLICT (session_id, agent) DO UPDATE SET
       foreign_id = COALESCE(excluded.foreign_id, binding.foreign_id),
       model = COALESCE(excluded.model, binding.model),
       effort = excluded.effort,
       permission = excluded.permission,
       status = CASE WHEN COALESCE(excluded.foreign_id, binding.foreign_id) IS NOT NULL
                     THEN 'bound' ELSE 'unbound' END,
       last_seen = excluded.last_seen`,
  ).run({
    sessionId: input.sessionId,
    agent: input.agent,
    foreignId: input.foreignId,
    model: input.model ?? null,
    effort: input.effort,
    permission: input.permission,
    status: input.foreignId ? 'bound' : 'unbound',
    lastSeen: now(),
  })
}

const toBinding = (r: Record<string, unknown> | null): Binding | null =>
  r
    ? {
        sessionId: r.session_id as string,
        agent: r.agent as AgentId,
        foreignId: (r.foreign_id as string | null) ?? null,
        model: (r.model as string | null) ?? null,
        effort: r.effort as string,
        permission: r.permission as Permission,
        status: r.status as Binding['status'],
        turns: r.turns as number,
        costUsd: r.cost_usd as number,
        credits: r.credits as number,
        lastSeen: (r.last_seen as number | null) ?? null,
      }
    : null

export function getBinding(db: Database, sessionId: string, agent: AgentId): Binding | null {
  return toBinding(
    db.query('SELECT * FROM binding WHERE session_id = $sessionId AND agent = $agent').get({
      sessionId,
      agent,
    }) as never,
  )
}

export function listBindings(db: Database, sessionId: string): Binding[] {
  const rows = db.query('SELECT * FROM binding WHERE session_id = $sessionId ORDER BY agent').all({
    sessionId,
  }) as never[]
  return rows.map((r) => toBinding(r)!).filter(Boolean)
}

// one query for every session's bound-agent count, instead of one `listBindings` per session
export function boundBindingCounts(db: Database): Map<string, number> {
  const rows = db
    .query('SELECT session_id, COUNT(*) AS bound FROM binding WHERE foreign_id IS NOT NULL GROUP BY session_id')
    .all() as { session_id: string; bound: number }[]
  return new Map(rows.map((r) => [r.session_id, r.bound]))
}

export function clearForeignId(db: Database, sessionId: string, agent: AgentId): void {
  db.query(
    "UPDATE binding SET foreign_id = NULL, status = 'unbound' WHERE session_id = $sessionId AND agent = $agent",
  ).run({ sessionId, agent })
}

export function recordTurn(
  db: Database,
  input: {
    sessionId: string
    agent: AgentId
    prompt: string
    final: string
    costUsd: number
    exitCode: number
    error?: string | null
    credits?: number
    inputTokens?: number
    outputTokens?: number
    kind?: string | null
    model?: string | null
    parentTurnId?: string | null
  },
): string {
  const turnId = id()
  db.query(
    `INSERT INTO turn (id, session_id, agent, prompt, final, cost_usd, credits, input_tokens,
       output_tokens, kind, gate_passed, exit_code, error, error_kind, started_at, ended_at, model,
       parent_turn_id)
     VALUES ($id, $sessionId, $agent, $prompt, $final, $costUsd, $credits, $inputTokens,
       $outputTokens, $kind, NULL, $exitCode, $error, NULL, $startedAt, $endedAt, $model,
       $parentTurnId)`,
  ).run({
    id: turnId,
    sessionId: input.sessionId,
    agent: input.agent,
    prompt: input.prompt,
    final: input.final,
    costUsd: input.costUsd,
    credits: input.credits ?? 0,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    kind: input.kind ?? null,
    exitCode: input.exitCode,
    error: input.error ?? null,
    startedAt: now(),
    endedAt: now(),
    model: input.model ?? null,
    parentTurnId: input.parentTurnId ?? null,
  })
  return turnId
}

export function lastTurnId(db: Database, sessionId: string): string | null {
  const row = db.query('SELECT id FROM turn WHERE session_id = $sessionId ORDER BY rowid DESC LIMIT 1').get({
    sessionId,
  }) as { id: string } | null
  return row?.id ?? null
}

// Who actually produced the most recent turn — which, after a failover move, is not
// necessarily the agent `send()` was originally asked to run.
export function lastTurnAgent(db: Database, sessionId: string): AgentId | null {
  const row = db.query('SELECT agent FROM turn WHERE session_id = $sessionId ORDER BY rowid DESC LIMIT 1').get({
    sessionId,
  }) as { agent: AgentId } | null
  return row?.agent ?? null
}

export function recordEvent(db: Database, turnId: string, seq: number, type: string, payload: unknown): void {
  db.query('INSERT INTO event (turn_id, seq, type, payload, ts) VALUES ($turnId, $seq, $type, $payload, $ts)').run({
    turnId,
    seq,
    type,
    payload: JSON.stringify(payload),
    ts: now(),
  })
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function lockOwner(db: Database, sessionId: string): string | null {
  const row = db.query('SELECT owner, pid FROM lock WHERE session_id = $sessionId').get({ sessionId }) as
    | { owner: string; pid: number }
    | null
  if (!row) return null
  return isAlive(row.pid) ? row.owner : null
}

export function reclaimStaleLock(db: Database, sessionId: string, owner: string, pid: number): boolean {
  const res = db
    .query('DELETE FROM lock WHERE session_id = $sessionId AND owner = $owner AND pid = $pid')
    .run({ sessionId, owner, pid })
  return res.changes > 0
}

export function acquireLock(db: Database, sessionId: string, owner: string): boolean {
  const row = db.query('SELECT owner, pid FROM lock WHERE session_id = $sessionId').get({ sessionId }) as
    | { owner: string; pid: number }
    | null
  if (row) {
    if (row.owner === owner) return true
    if (isAlive(row.pid)) return false
    reclaimStaleLock(db, sessionId, row.owner, row.pid)
  }
  const res = db
    .query(
      `INSERT INTO lock (session_id, owner, pid, acquired_at) VALUES ($sessionId, $owner, $pid, $at)
       ON CONFLICT (session_id) DO NOTHING`,
    )
    .run({ sessionId, owner, pid: process.pid, at: now() })
  return res.changes > 0
}

export function releaseLock(db: Database, sessionId: string, owner: string): void {
  db.query('DELETE FROM lock WHERE session_id = $sessionId AND owner = $owner').run({ sessionId, owner })
}

export function setGateResult(db: Database, turnId: string, passed: boolean): void {
  db.query('UPDATE turn SET gate_passed = $passed WHERE id = $turnId').run({ turnId, passed: passed ? 1 : 0 })
}

export function turnExitCode(db: Database, turnId: string): number | null {
  const row = db.query('SELECT exit_code FROM turn WHERE id = $turnId').get({ turnId }) as { exit_code: number } | null
  return row ? row.exit_code : null
}

export function bumpBinding(
  db: Database,
  sessionId: string,
  agent: AgentId,
  costUsd: number,
  credits = 0,
): void {
  db.query(
    `UPDATE binding SET turns = turns + 1, cost_usd = cost_usd + $costUsd, credits = credits + $credits,
       last_seen = $lastSeen WHERE session_id = $sessionId AND agent = $agent`,
  ).run({ sessionId, agent, costUsd, credits, lastSeen: now() })
}

export interface UsageRow {
  agent: AgentId
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  credits: number
  gatePassed: number
  gateKnown: number
}

const USAGE_COLUMNS = `agent,
  COUNT(*) AS turns,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(credits), 0) AS credits,
  COALESCE(SUM(CASE WHEN gate_passed = 1 THEN 1 ELSE 0 END), 0) AS gate_passed,
  COALESCE(SUM(CASE WHEN gate_passed IS NULL THEN 0 ELSE 1 END), 0) AS gate_known`

const toUsage = (r: Record<string, unknown>): UsageRow => ({
  agent: r.agent as AgentId,
  turns: r.turns as number,
  inputTokens: r.input_tokens as number,
  outputTokens: r.output_tokens as number,
  costUsd: r.cost_usd as number,
  credits: r.credits as number,
  gatePassed: r.gate_passed as number,
  gateKnown: r.gate_known as number,
})

export function usageForSession(db: Database, sessionId: string): UsageRow[] {
  const rows = db
    .query(`SELECT ${USAGE_COLUMNS} FROM turn WHERE session_id = $sessionId GROUP BY agent ORDER BY agent`)
    .all({ sessionId }) as Record<string, unknown>[]
  return rows.map(toUsage)
}

export function usageAcrossSessions(db: Database): UsageRow[] {
  const rows = db
    .query(`SELECT ${USAGE_COLUMNS} FROM turn GROUP BY agent ORDER BY agent`)
    .all() as Record<string, unknown>[]
  return rows.map(toUsage)
}

// same COALESCE/SUM style as USAGE_COLUMNS, on purpose: this and the per-agent totals above
// must never treat a null differently, or the two views of the same turns would disagree
const USAGE_BY_MODEL_COLUMNS = `agent,
  model,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(credits), 0) AS credits`

export function usageByAgentModel(db: Database, sessionId?: string): ModelUsage[] {
  const sql = sessionId
    ? `SELECT ${USAGE_BY_MODEL_COLUMNS} FROM turn
       WHERE session_id = $sessionId GROUP BY agent, model ORDER BY agent, model`
    : `SELECT ${USAGE_BY_MODEL_COLUMNS} FROM turn GROUP BY agent, model ORDER BY agent, model`
  const rows = (sessionId ? db.query(sql).all({ sessionId }) : db.query(sql).all()) as Record<string, unknown>[]
  return rows.map((r) => ({
    agent: r.agent as AgentId,
    model: (r.model as string | null) ?? null,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    costUsd: r.cost_usd as number,
    credits: r.credits as number,
  }))
}

// 'localtime' matters: without it SQLite buckets by UTC, so every turn run between midnight
// and the local UTC offset lands on the previous day's square — verified on this machine
// (UTC+3), where a turn at 01:30 on the 21st was reported as the 20th.
const DAY_EXPR = "date(started_at / 1000, 'unixepoch', 'localtime')"

export function turnsPerDay(db: Database, sessionId?: string): { day: string; count: number }[] {
  const sql = sessionId
    ? `SELECT ${DAY_EXPR} AS day, COUNT(*) AS count FROM turn
       WHERE session_id = $sessionId GROUP BY day ORDER BY day`
    : `SELECT ${DAY_EXPR} AS day, COUNT(*) AS count FROM turn GROUP BY day ORDER BY day`
  const rows = (sessionId ? db.query(sql).all({ sessionId }) : db.query(sql).all()) as Record<string, unknown>[]
  return rows.map((r) => ({ day: r.day as string, count: r.count as number }))
}

export function turnsPerDayByAgent(
  db: Database,
  sessionId?: string,
): { agent: AgentId; day: string; count: number }[] {
  const sql = sessionId
    ? `SELECT agent, ${DAY_EXPR} AS day, COUNT(*) AS count FROM turn
       WHERE session_id = $sessionId GROUP BY agent, day ORDER BY agent, day`
    : `SELECT agent, ${DAY_EXPR} AS day, COUNT(*) AS count FROM turn GROUP BY agent, day ORDER BY agent, day`
  const rows = (sessionId ? db.query(sql).all({ sessionId }) : db.query(sql).all()) as Record<string, unknown>[]
  return rows.map((r) => ({ agent: r.agent as AgentId, day: r.day as string, count: r.count as number }))
}
