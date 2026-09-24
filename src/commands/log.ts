import type { Database } from 'bun:sqlite'
import { recentTurns, type TurnRecord } from '../store/queries'
import { requireSession } from './messages'
import { ago, outputColor, spend, table } from '../format'
import { duration, tokens } from '../render'
import { oneLine, safeText } from '../adapters/types'
import { agentPaint, colorLevel, palette } from '../style'
import { markdownRenderer } from '../markdown'

// How a turn ended, in one word: the kinds konvoy already records, read the way a person asks.
export function outcome(t: TurnRecord): string {
  if (t.exitCode === -1) return 'running'
  if (t.errorKind === 'interrupted') return 'interrupted'
  if (t.errorKind && t.final.trim() === '') return t.errorKind
  if (t.errorKind) return `ok, then ${t.errorKind}`
  return t.exitCode === 0 ? 'ok' : `exit ${t.exitCode}`
}

const turnSpend = (t: TurnRecord): string =>
  spend({ agent: t.agent, turns: 1, inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd, credits: t.credits, gatePassed: 0, gateKnown: 0 })

// What a session did, newest first: the question a person asks after stepping away, and the one
// no command answered - `usage` sums the turns and `roster` counts them, neither says what they were.
export function cmdLog(db: Database, cwd: string, opts: { slug?: string; limit?: number; json?: boolean }): number {
  const session = requireSession(db, cwd, opts.slug)
  if (!session) return 2
  const limit = opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20
  const turns = recentTurns(db, session.id, limit)
  if (opts.json) {
    console.log(JSON.stringify(turns.map((t, i) => ({ n: i + 1, ...t, outcome: outcome(t) })), null, 2))
    return 0
  }
  if (turns.length === 0) {
    console.log(`session ${session.slug} - no turns yet`)
    return 0
  }
  const now = Date.now()
  const width = Math.max(40, (process.stdout.columns ?? 100) - 70)
  console.log(
    table(
      ['#', 'WHEN', 'AGENT', 'OUTCOME', 'TIME', 'IN', 'OUT', 'SPEND', 'PROMPT'],
      turns.map((t, i) => [
        String(i + 1),
        ago(t.startedAt, now),
        // a turn konvoy started for the one above it - a handoff, a failover - is marked as one
        t.parentTurnId ? `↳ ${t.agent}` : t.agent,
        outcome(t),
        t.exitCode === -1 ? '-' : duration(Math.max(0, t.endedAt - t.startedAt)),
        tokens(t.inputTokens),
        tokens(t.outputTokens),
        turnSpend(t),
        oneLine(t.prompt, width),
      ]),
      { right: [0, 4, 5, 6, 7], color: outputColor(), agentColumn: 2 },
    ).trimEnd(),
  )
  return 0
}

// One turn in full, the way it would have read live: who, how it went, what was asked, the whole
// answer. `N` counts back from the latest, the numbering `konvoy log` prints.
export function cmdShow(db: Database, cwd: string, opts: { slug?: string; which?: string }): number {
  const session = requireSession(db, cwd, opts.slug)
  if (!session) return 2
  const n = opts.which === undefined ? 1 : Number(opts.which)
  if (!Number.isInteger(n) || n < 1) {
    console.error('usage: konvoy show [N] - N counts back from the latest turn, as `konvoy log` numbers them')
    return 2
  }
  const turn = recentTurns(db, session.id, n)[n - 1]
  if (!turn) {
    console.error(n === 1 ? `session ${session.slug} has no turns yet` : `session ${session.slug} has fewer than ${n} turns`)
    return 2
  }
  const level = colorLevel(Bun.env, Boolean(process.stdout.isTTY))
  const p = palette(level)
  const head = [agentPaint(level)(turn.agent)(turn.agent), ago(turn.startedAt, Date.now()), outcome(turn)]
  if (turn.exitCode !== -1) head.push(duration(Math.max(0, turn.endedAt - turn.startedAt)))
  const cost = turnSpend(turn)
  if (cost !== '-') head.push(cost)
  // the header and the prompt are chrome; the answer alone is stdout's, so `konvoy show > a.md` is the answer
  console.error(p.dim(`#${n} · `) + head.join(p.dim(' · ')))
  console.error(`${p.dim('›')} ${safeText(turn.prompt)}`)
  console.error('')
  const answer = safeText(turn.final)
  if (answer.trim() === '') {
    console.error(p.dim(turn.error ? `  no answer: ${oneLine(turn.error)}` : '  no answer'))
    return 0
  }
  if (level > 0) {
    const md = markdownRenderer({ p, accent: agentPaint(level)(turn.agent), code: p.cyan }, () => process.stdout.columns ?? 80)
    console.log(answer.replace(/\n$/, '').split('\n').map((l) => md.line(l)).join('\n'))
  } else {
    console.log(answer.replace(/\n$/, ''))
  }
  return 0
}
