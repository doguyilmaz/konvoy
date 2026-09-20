// Committed mutation registry: each entry is a real defect that was once proven caught by
// hand (mutation applied, named test watched to fail, source restored) during this project's
// development. `bun run mutate` (tests/mutations/run.ts) re-runs
// every entry here: applies it, runs only the named test files, expects them to fail, restores
// the file, and asserts the restore was byte-identical. A MISSED entry means a real test gap;
// a BROKEN entry means the source moved and the entry needs updating, not deleting blindly.
export interface Mutation {
  /** what defect this introduces, in plain words */
  name: string
  /** repo-relative source path */
  file: string
  /** exact substring, must appear EXACTLY once in `file` */
  from: string
  /** what replaces it */
  to: string
  /** test files that must fail while the mutation is applied */
  tests: string[]
}

export const mutations: Mutation[] = [
  // --- security guards (src/config/load.ts, src/config/schema.ts, src/adapters/types.ts, src/commands/config.ts) ---
  {
    name: 'a project config can set agents.<id>.bin, seizing the binary konvoy spawns',
    file: 'src/config/load.ts',
    from: "const PRIVILEGED_AGENT_KEYS = ['bin', 'permission', 'harness'] as const",
    to: "const PRIVILEGED_AGENT_KEYS = ['permission', 'harness'] as const",
    tests: ['tests/config-security.test.ts'],
  },
  {
    name: 'a leading-dash model string is accepted and reaches argv as a flag injection',
    file: 'src/config/load.ts',
    from: 'const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/',
    to: 'const MODEL_PATTERN = /^[A-Za-z0-9._:-]*$/',
    tests: ['tests/config-security.test.ts'],
  },
  {
    name: 'policy.turnTimeoutSec is no longer clamped, so a hostile repo can make konvoy wait forever',
    file: 'src/config/schema.ts',
    from: '.transform((v) => Math.min(v, MAX_TURN_TIMEOUT_SEC)),',
    to: '.transform((v) => v),',
    tests: ['tests/config-security.test.ts'],
  },
  {
    name: 'stripControlChars no longer strips ESC, letting a terminal escape sequence through',
    file: 'src/adapters/types.ts',
    from: "  return value.replace(/[\\x00-\\x1f\\x7f]/g, '')",
    to: "  return value.replace(/[\\x00-\\x1a\\x7f]/g, '')",
    tests: ['tests/adapter-claude.test.ts'],
  },
  {
    name: 'RATE loses its literal HTTP 429 alternative, misclassifying a real rate-limit response',
    file: 'src/adapters/types.ts',
    from:
      '  /hit your \\w+ limit|rate[_ ]?limit|quota exceeded|too ?many ?requests|usage limit|weekly limit|\\d+[- ]hour (?:usage )?limit|throttl|\\b429\\b/',
    to:
      '  /hit your \\w+ limit|rate[_ ]?limit|quota exceeded|too ?many ?requests|usage limit|weekly limit|\\d+[- ]hour (?:usage )?limit|throttl/',
    tests: ['tests/adapter-claude.test.ts'],
  },
  {
    name: 'classifyError drops the UPSTREAM check, misclassifying a refusing-but-reachable API as unknown',
    file: 'src/adapters/types.ts',
    from: "  if (UPSTREAM.test(m)) return 'upstream'\n",
    to: '',
    tests: ['tests/adapter-claude.test.ts'],
  },
  {
    name: 'classifyError checks UPSTREAM before RATE, so a rate limit mentioning 503 is misread as an outage',
    file: 'src/adapters/types.ts',
    from: "  if (RATE.test(m)) return 'rate'\n  if (UPSTREAM.test(m)) return 'upstream'\n",
    to: "  if (UPSTREAM.test(m)) return 'upstream'\n  if (RATE.test(m)) return 'rate'\n",
    tests: ['tests/adapter-claude.test.ts'],
  },
  {
    name: '`konvoy config set __proto__.x` reaches Object.prototype instead of being rejected',
    file: 'src/commands/config.ts',
    from: "const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])",
    to: "const RESERVED = new Set(['constructor', 'prototype'])",
    tests: ['tests/config-write.test.ts'],
  },
  {
    name: 'setPath skips its own reserved-key guard, so the __proto__ check never runs for writes',
    file: 'src/commands/config.ts',
    from: ["  assertSafe(dotted)", "  const keys = dotted.split('.')"].join('\n'),
    to: "  const keys = dotted.split('.')",
    tests: ['tests/config-write.test.ts'],
  },

  // --- the error-kind exemption (src/core/turn.ts, src/cli.ts, src/core/session.ts, src/commands/attach.ts) ---
  {
    name: 'an auth/rate error is nulled out the moment a turn streamed any text, hiding that the agent is blocked',
    file: 'src/core/turn.ts',
    from: "const blocking = result.error?.kind === 'auth' || result.error?.kind === 'rate'",
    to: 'const blocking = false',
    tests: ['tests/turn.test.ts'],
  },
  {
    name: 'the blocking exemption is narrowed to rate only, so an auth error after real output is discarded',
    file: 'src/core/turn.ts',
    from: "const blocking = result.error?.kind === 'auth' || result.error?.kind === 'rate'",
    to: "const blocking = result.error?.kind === 'rate'",
    tests: ['tests/turn.test.ts'],
  },
  {
    name: 'a child that traps SIGTERM hangs forever instead of being escalated to SIGKILL',
    file: 'src/core/turn.ts',
    from: "if (proc.exitCode === null) proc.kill('SIGKILL')",
    to: "if (false) proc.kill('SIGKILL')",
    tests: ['tests/turn.test.ts'],
  },
  {
    name: 'no top-level try/catch: a malformed config or an unreadable database escapes main() as a raw stack trace',
    file: 'src/cli.ts',
    from: [
      '  try {',
      '    return await dispatch(command, rest, cwd, slug, args)',
      '  } catch (error) {',
      "    if (Bun.env.KONVOY_DEBUG === '1') throw error",
      '    console.error(`konvoy: ${error instanceof Error ? error.message : String(error)}`)',
      '    return 1',
      '  }',
    ].join('\n'),
    to: '  return await dispatch(command, rest, cwd, slug, args)',
    tests: ['tests/cli.test.ts'],
  },
  {
    name: 'send() no longer checks the binary is installed, so a missing agent surfaces a raw ENOENT from Bun.spawn',
    file: 'src/core/session.ts',
    from: 'if (!detection.installed) throw new Error(`${agent}: not installed`)',
    to: 'if (false) throw new Error(`${agent}: not installed`)',
    tests: ['tests/session.test.ts', 'tests/send.test.ts'],
  },
  {
    name: 'cmdAttach no longer checks the binary is installed before spawning it',
    file: 'src/commands/attach.ts',
    from: '  if (!detection.installed) {',
    to: '  if (false) {',
    tests: ['tests/attach.test.ts'],
  },

  // --- day bucketing (src/store/queries.ts) ---
  {
    name: "turnsPerDay/turnsPerDayByAgent bucket by UTC day instead of local day, misfiling turns near midnight",
    file: 'src/store/queries.ts',
    from: `const DAY_EXPR = "date(started_at / 1000, 'unixepoch', 'localtime')"`,
    to: `const DAY_EXPR = "date(started_at / 1000, 'unixepoch')"`,
    tests: ['tests/usage.test.ts'],
  },

  // --- pricing rules (src/pricing.ts, src/format.ts, src/store/queries.ts) ---
  {
    name: 'estimateUsd prices a credit-billed row by its model as well, double-counting it',
    file: 'src/pricing.ts',
    from: [
      '  if (row.credits > 0) {',
      '    const rate = pricing.credits[row.agent]',
      '    if (rate) return row.credits * rate.usdPerCredit',
      '  }',
      '',
      '  if (row.model) {',
      '    const rate = pricing.models[row.model]',
      '    if (rate) {',
      '      return (row.inputTokens / 1_000_000) * rate.inputPerMTok +',
      '        (row.outputTokens / 1_000_000) * rate.outputPerMTok',
      '    }',
      '  }',
    ].join('\n'),
    to: [
      '  if (row.model) {',
      '    const rate = pricing.models[row.model]',
      '    if (rate) {',
      '      return (row.inputTokens / 1_000_000) * rate.inputPerMTok +',
      '        (row.outputTokens / 1_000_000) * rate.outputPerMTok',
      '    }',
      '  }',
      '',
      '  if (row.credits > 0) {',
      '    const rate = pricing.credits[row.agent]',
      '    if (rate) return row.credits * rate.usdPerCredit',
      '  }',
    ].join('\n'),
    tests: ['tests/pricing.test.ts'],
  },
  {
    name: 'estimateUsd returns 0 instead of null for an unpriced model, reporting "free" instead of "unknown"',
    file: 'src/pricing.ts',
    from: [
      '  return null',
      '}',
      '',
      '// pricing defaults to empty, so an unconfigured user must never see a ~USD column of dashes —',
    ].join('\n'),
    to: [
      '  return 0',
      '}',
      '',
      '// pricing defaults to empty, so an unconfigured user must never see a ~USD column of dashes —',
    ].join('\n'),
    tests: ['tests/pricing.test.ts'],
  },
  {
    name: 'estimateAgentUsd reports the partial sum of only its priced rows instead of "unknown" for the whole agent',
    file: 'src/pricing.ts',
    from: ['    if (est === null) return null', '    total += est'].join('\n'),
    to: ['    if (est === null) continue', '    total += est'].join('\n'),
    tests: ['tests/pricing.test.ts', 'tests/usage.test.ts'],
  },
  {
    name: "spend() prefers dollars over credits, disagreeing with the estimator on which figure is real",
    file: 'src/format.ts',
    from: [
      '  if (row.credits > 0) return `${row.credits.toFixed(3)} cr`',
      '  if (row.costUsd > 0) return `$${row.costUsd.toFixed(2)}`',
      "  return '-'",
    ].join('\n'),
    to: [
      '  if (row.costUsd > 0) return `$${row.costUsd.toFixed(2)}`',
      '  if (row.credits > 0) return `${row.credits.toFixed(3)} cr`',
      "  return '-'",
    ].join('\n'),
    tests: ['tests/usage.test.ts'],
  },
  {
    name: 'usageByAgentModel groups by agent only, merging different models of the same agent together',
    file: 'src/store/queries.ts',
    from: '       WHERE session_id = $sessionId GROUP BY agent, model ORDER BY agent, model',
    to: '       WHERE session_id = $sessionId GROUP BY agent ORDER BY agent',
    tests: ['tests/usage.test.ts'],
  },

  // --- rm / deleteSession cascade (src/commands/rm.ts, src/store/queries.ts) ---
  {
    name: 'cmdRm no longer refuses when another process holds the session lock',
    file: 'src/commands/rm.ts',
    from: '  if (busy) {',
    to: '  if (false && busy) {',
    tests: ['tests/resume.test.ts'],
  },
  {
    name: 'cmdRm deletes a session without requiring --yes',
    file: 'src/commands/rm.ts',
    from: '  if (!opts.yes) {',
    to: '  if (false) {',
    tests: ['tests/resume.test.ts'],
  },
  {
    name: 'cmdRm reports the total binding count instead of only the bound ones, and lists unbound agents as survivors',
    file: 'src/commands/rm.ts',
    from: '  const bound = listBindings(db, session.id).filter((b) => b.foreignId)',
    to: '  const bound = listBindings(db, session.id)',
    tests: ['tests/resume.test.ts'],
  },
  {
    name: "deleteSession's cascade skips the lock table, leaving a dangling lock row behind",
    file: 'src/store/queries.ts',
    from: "    db.query('DELETE FROM lock WHERE session_id = $id').run({ id })\n",
    to: '',
    tests: ['tests/store.test.ts'],
  },
  {
    name: 'deleteSession runs its cascade without a transaction, so a failing statement leaves earlier deletes applied',
    file: 'src/store/queries.ts',
    from: [
      'export function deleteSession(db: Database, id: string): void {',
      '  db.transaction(() => {',
      "    db.query('DELETE FROM event WHERE turn_id IN (SELECT id FROM turn WHERE session_id = $id)').run({ id })",
      "    db.query('DELETE FROM turn WHERE session_id = $id').run({ id })",
      "    db.query('DELETE FROM binding WHERE session_id = $id').run({ id })",
      "    db.query('DELETE FROM lock WHERE session_id = $id').run({ id })",
      "    db.query('DELETE FROM session WHERE id = $id').run({ id })",
      '  })()',
      '}',
    ].join('\n'),
    to: [
      'export function deleteSession(db: Database, id: string): void {',
      "  db.query('DELETE FROM event WHERE turn_id IN (SELECT id FROM turn WHERE session_id = $id)').run({ id })",
      "  db.query('DELETE FROM turn WHERE session_id = $id').run({ id })",
      "  db.query('DELETE FROM binding WHERE session_id = $id').run({ id })",
      "  db.query('DELETE FROM lock WHERE session_id = $id').run({ id })",
      "  db.query('DELETE FROM session WHERE id = $id').run({ id })",
      '}',
    ].join('\n'),
    tests: ['tests/store.test.ts'],
  },
  {
    name: 'reclaimStaleLock deletes by session id alone, reintroducing the TOCTOU race it was written to close',
    file: 'src/store/queries.ts',
    from: "    .query('DELETE FROM lock WHERE session_id = $sessionId AND owner = $owner AND pid = $pid')",
    to: "    .query('DELETE FROM lock WHERE session_id = $sessionId')",
    tests: ['tests/store.test.ts'],
  },

  // --- dashboard (src/dashboard/page.ts, src/commands/dashboard.ts) ---
  {
    name: 'the dashboard page no longer HTML-escapes values pulled from the database',
    file: 'src/dashboard/page.ts',
    from: `  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)`,
    to: '  return text',
    tests: ['tests/dashboard.test.ts'],
  },
  {
    name: 'the dashboard server binds to every interface instead of loopback only',
    file: 'src/commands/dashboard.ts',
    from: ["    hostname: '127.0.0.1',", '    port: opts.port ?? 0,'].join('\n'),
    to: '    port: opts.port ?? 0,',
    tests: ['tests/dashboard.test.ts'],
  },
  {
    name: 'an unpriced agent renders $0.00 on the dashboard instead of a dash',
    file: 'src/dashboard/page.ts',
    from: "  if (a.estimateUsd === null) return '-'",
    to: "  if (a.estimateUsd === null) return '$0.00'",
    tests: ['tests/dashboard.test.ts'],
  },
  {
    name: "the dashboard's per-agent bars each scale to their own row instead of a shared maximum",
    file: 'src/dashboard/page.ts',
    from: 'const h = v > 0 ? Math.max(1, Math.round((v / sharedMax) * (rowHeight - 2))) : 0',
    to: 'const h = v > 0 ? Math.max(1, Math.round((v / Math.max(...values, 1)) * (rowHeight - 2))) : 0',
    tests: ['tests/dashboard.test.ts'],
  },
  {
    name: 'dashboard collect() ignores its sessionId argument and always aggregates every session',
    file: 'src/dashboard/page.ts',
    from: [
      'export function collect(db: Database, cfg: Config, sessionId?: string): DashboardData {',
      '  const rows = sessionId ? usageForSession(db, sessionId) : usageAcrossSessions(db)',
      '  const modelRows = usageByAgentModel(db, sessionId)',
    ].join('\n'),
    to: [
      'export function collect(db: Database, cfg: Config, sessionId?: string): DashboardData {',
      '  const rows = usageAcrossSessions(db)',
      '  const modelRows = usageByAgentModel(db)',
    ].join('\n'),
    tests: ['tests/dashboard.test.ts'],
  },

  // --- the CLI command table single source of truth (src/commands/table.ts) ---
  {
    name: 'the `rm` command is dropped from commandTable, so README still documents a command that no longer resolves',
    file: 'src/commands/table.ts',
    from: [
      '  {',
      "    name: 'rm',",
      '    aliases: [],',
      "    usage: 'rm <session> --yes',",
      "    summary: 'delete a konvoy session (foreign sessions survive)',",
      '  },',
    ].join('\n'),
    to: '',
    tests: ['tests/docs.test.ts'],
  },

  // --- the update guard (src/commands/update.ts) ---
  {
    name: 'updateCommand ignores a configured bin and always runs the bare CLI name',
    file: 'src/commands/update.ts',
    from: 'return [bin ?? name!, ...rest]',
    to: 'return [name!, ...rest]',
    tests: ['tests/update.test.ts'],
  },
  {
    name: 'cmdUpdate no longer skips agents disabled in config',
    file: 'src/commands/update.ts',
    from: '    if (!settings.enabled) {',
    to: '    if (false) {',
    tests: ['tests/update.test.ts'],
  },
  {
    name: "a failing agent update is not counted as a failure, so cmdUpdate exits 0 even though one update failed",
    file: 'src/commands/update.ts',
    from: 'failures++',
    to: '',
    tests: ['tests/update.test.ts'],
  },

  // --- machine facts render as rows, not objects (src/core/facts.ts) ---
  {
    name: 'formatFacts emits a JSON object per file row instead of a comma-separated row',
    file: 'src/core/facts.ts',
    from: 'facts.files.map((f) => [f.path, String(f.added), String(f.removed)])',
    to: 'facts.files.map((f) => [JSON.stringify(f)])',
    tests: ['tests/facts.test.ts'],
  },
  {
    name: 'formatFacts prints a files[] header even when there are no changed files',
    file: 'src/core/facts.ts',
    from: 'if (facts.files.length > 0) {',
    to: 'if (true) {',
    tests: ['tests/facts.test.ts'],
  },
  {
    name: 'a facts field carrying the delimiter is emitted unquoted, so every later column shifts',
    file: 'src/core/facts.ts',
    from: 'function cell(value: string): string {',
    to: 'function cell(value: string): string { return value;',
    tests: ['tests/facts.test.ts'],
  },
  {
    name: 'every facts field is quoted whether it needs it or not, spending tokens on nothing',
    file: 'src/core/facts.ts',
    from: '/[",\\n]/.test(value)',
    to: 'true',
    tests: ['tests/facts.test.ts'],
  },

  // --- the prelude (src/core/prelude.ts, src/adapters/types.ts) ---
  {
    name: 'withPrelude drops the prelude and returns the prompt alone, undoing the handoff',
    file: 'src/adapters/types.ts',
    from: "  const base = ctx.prelude ? `${ctx.prelude}\\n\\n${ctx.prompt}` : ctx.prompt",
    to: '  const base = ctx.prompt',
    tests: ['tests/prelude.test.ts'],
  },
  {
    name: 'withPrelude joins the prompt before the prelude, so the volatile part leads the cached prefix',
    file: 'src/adapters/types.ts',
    from: "  const base = ctx.prelude ? `${ctx.prelude}\\n\\n${ctx.prompt}` : ctx.prompt",
    to: '  const base = ctx.prelude ? `${ctx.prompt}\\n\\n${ctx.prelude}` : ctx.prompt',
    tests: ['tests/prelude.test.ts'],
  },
  {
    name: "a derived prelude drops its not-recorded notice, so the receiver believes its context is complete",
    file: 'src/core/prelude.ts',
    from:
      '    turnBlocks.push("the previous agent\'s intent was not recorded here — only what was asked and answered is known.")\n',
    to: '',
    tests: ['tests/prelude.test.ts'],
  },
  {
    name: 'the cap on recent turns is removed, so buildPrelude replays every turn in the session instead of a window',
    file: 'src/core/prelude.ts',
    from: 'limit: opts.recent',
    to: 'limit: 1000',
    tests: ['tests/prelude.test.ts'],
  },

  // --- the failover chain (src/core/session.ts) ---
  {
    name: "the failover chain also moves on a crash, so a second agent spends its budget failing the same way",
    file: 'src/core/session.ts',
    from: "      const movable = kind === 'rate' || kind === 'auth' || kind === 'upstream'",
    to: "      const movable = kind === 'rate' || kind === 'auth' || kind === 'upstream' || kind === 'crash'",
    tests: ['tests/failover.test.ts'],
  },
  {
    name: 'an upstream error moves to the next agent immediately instead of retrying with backoff first',
    file: 'src/core/session.ts',
    from: "        if (r.error?.kind === 'upstream' && retries < upstreamRetries) {",
    to: '        if (false) {',
    tests: ['tests/failover.test.ts'],
  },
  {
    name: 'a rate limit is retried on the same agent before moving, burning seconds against an hours-long window',
    file: 'src/core/session.ts',
    from: "        if (r.error?.kind === 'upstream' && retries < upstreamRetries) {",
    to: "        if ((r.error?.kind === 'upstream' || r.error?.kind === 'rate') && retries < upstreamRetries) {",
    tests: ['tests/failover.test.ts'],
  },
  {
    name: 'the replacement turn is recorded with no parentTurnId, losing the link to the turn it replaced',
    file: 'src/core/session.ts',
    from: '        r = await runOnce(current, currentAdapter, ctxBuild, firstTurnId)',
    to: '        r = await runOnce(current, currentAdapter, ctxBuild, null)',
    tests: ['tests/failover.test.ts'],
  },
  {
    name: 'a chain member that cannot run is skipped without telling anyone',
    file: 'src/core/session.ts',
    from: 'if (!isHead) {',
    to: 'if (false) {',
    tests: ['tests/failover.test.ts'],
  },
  {
    name: 'the handover is never announced, so a switched agent looks like the one asked for',
    file: 'src/core/session.ts',
    from: 'blocked = { agent: current, kind: kind!, message: result.error!.message }',
    to: 'blocked = null',
    tests: ['tests/failover.test.ts'],
  },

  // --- the brief style (src/adapters/types.ts, src/config/load.ts) ---
  {
    name: 'the brief instruction is prepended ahead of the prompt instead of appended after it',
    file: 'src/adapters/types.ts',
    from: "  const styled = ctx.style === 'brief' ? `${base}\\n\\n${BRIEF_INSTRUCTION}` : base",
    to: "  const styled = ctx.style === 'brief' ? `${BRIEF_INSTRUCTION}\\n\\n${base}` : base",
    tests: ['tests/style.test.ts'],
  },
  {
    name: 'the brief instruction is appended even when style is unset, decorating every prompt',
    file: 'src/adapters/types.ts',
    from: "  const styled = ctx.style === 'brief' ? `${base}\\n\\n${BRIEF_INSTRUCTION}` : base",
    to: '  const styled = `${base}\\n\\n${BRIEF_INSTRUCTION}`',
    tests: ['tests/style.test.ts'],
  },
  {
    name: 'a per-agent style: null no longer overrides a defaults.style, so an agent cannot opt out',
    file: 'src/config/load.ts',
    from: 'const style = ownStyle === null ? undefined : (ownStyle ?? defaultStyle)',
    to: 'const style = ownStyle ?? defaultStyle',
    tests: ['tests/style.test.ts'],
  },

  // --- the delegation envelope instruction (src/adapters/types.ts) ---
  {
    name: 'the delegation instruction is emitted even when delegation is off, paying for it on every turn',
    file: 'src/adapters/types.ts',
    from: "  return ctx.delegation ? `${styled}\\n\\n${DELEGATION_INSTRUCTION}` : styled",
    to: "  return `${styled}\\n\\n${DELEGATION_INSTRUCTION}`",
    tests: ['tests/envelope.test.ts'],
  },
  {
    name: 'the delegation instruction is prepended ahead of the prompt instead of appended after it',
    file: 'src/adapters/types.ts',
    from: "  return ctx.delegation ? `${styled}\\n\\n${DELEGATION_INSTRUCTION}` : styled",
    to: "  return ctx.delegation ? `${DELEGATION_INSTRUCTION}\\n\\n${styled}` : styled",
    tests: ['tests/envelope.test.ts'],
  },
  {
    name: 'the "emit nothing when not handing over" sentence is dropped, so every turn pays for a block nobody reads',
    file: 'src/adapters/types.ts',
    from: "  '>>>\\n' +\n  'If this turn is not handing work over, emit nothing — no block at all.'",
    to: "  '>>>\\n' +\n  ''",
    tests: ['tests/envelope.test.ts'],
  },

  // --- the gate (src/core/gate.ts, src/config/load.ts) ---
  {
    name: 'a command that cannot be spawned records a failing verdict instead of no verdict at all',
    file: 'src/core/gate.ts',
    from: '  } catch {\n    // could not spawn: a misconfiguration, not a verdict on the work, so nothing is recorded\n  }',
    to: '  } catch {\n    setGateResult(db, turnId, false)\n  }',
    tests: ['tests/gate.test.ts'],
  },
  {
    name: 'the gate runs even when no command is configured',
    file: 'src/core/gate.ts',
    from: '  if (!command) return',
    to: '  if (false) return',
    tests: ['tests/gate.test.ts'],
  },
  {
    name: 'the gate runs on a turn that failed, blaming the agent for a block it produced nothing for',
    file: 'src/core/gate.ts',
    from: '  if (turnExitCode(db, turnId) !== 0) return',
    to: '  if (false) return',
    tests: ['tests/gate.test.ts'],
  },
  {
    name: 'a project layer can name the gate command, so a cloned repo runs arbitrary code unprompted',
    file: 'src/config/load.ts',
    from: "const PRIVILEGED_TOP_LEVEL_KEYS = ['gate'] as const",
    to: 'const PRIVILEGED_TOP_LEVEL_KEYS = [] as const',
    tests: ['tests/gate.test.ts'],
  },
  {
    name: 'the prelude is built but never put on the context, so a successor agent arrives blind',
    file: 'src/core/session.ts',
    from: '        prompt,\n        prelude,',
    to: '',
    tests: ['tests/session.test.ts'],
  },

  // --- the delegation handoff (src/core/session.ts) ---
  {
    name: 'a handoff envelope is followed even when delegation is disabled in config',
    file: 'src/core/session.ts',
    from: 'if (!deps.cfg.delegation.enabled || result.error) return null',
    to: 'if (result.error) return null',
    tests: ['tests/delegation.test.ts'],
  },
  {
    name: 'the delegated turn is allowed to hand off again, chaining past the one hop per send',
    file: 'src/core/session.ts',
    from: '    return handoff',
    to: '    return (await followHandoff(handoff, handoffTurnId)) ?? handoff',
    tests: ['tests/delegation.test.ts'],
  },
  {
    name: 'an envelope naming no real agent or role is silently dropped instead of reported, leaving nobody told the turn stood',
    file: 'src/core/session.ts',
    from: "    if (!recipient) {\n      console.error(\n        `konvoy: ${ranAsAgent} handed off to \"${envelope.to}\" — no such agent or role, ${ranAsAgent}'s turn stands`,\n      )\n      return null\n    }",
    to: '    if (!recipient) return null',
    tests: ['tests/delegation.test.ts'],
  },
  {
    name: 'the delegated turn is run with no parentTurnId, losing the link to the turn that handed it over',
    file: 'src/core/session.ts',
    from: '      }),\n      turnId,\n    )\n  }',
    to: '      }),\n      null,\n    )\n  }',
    tests: ['tests/delegation.test.ts'],
  },
]
