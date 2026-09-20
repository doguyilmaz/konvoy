// bun run smoke — two live turns per installed, authenticated agent, run through konvoy's own
// send() so the real adapter, parser, store and resume path are exercised instead of a
// reimplementation. The first turn stores a nonce; the second resumes the binding konvoy
// captured and asks for it back. That second answer is the only cheap proof of konvoy's central
// promise — that a bound session carries its context — and every unit test of it uses fakes.
// This spends real agent quota: opt-in only, and never reachable from `bun test`.
//
// The fixtures in tests/fixtures/streams/ are frozen against a CLI version captured on the day
// they were recorded (see provenance.json) — they prove a parser handled that day's output, not
// today's. A passing smoke run against a newer installed version is the signal that it's time
// to re-capture; this script says so rather than staying silently green while the fixture ages.
import type { Database } from 'bun:sqlite'
import type { AgentId } from '../src/types'
import type { Adapter } from '../src/adapters/types'
import type { Config } from '../src/config/schema'
import { agentIds } from '../src/config/schema'
import { openDb } from '../src/store/db'
import { loadConfig, resolveAgent } from '../src/config/load'
import { detect, detectAuth, type DetectDeps } from '../src/core/detect'
import { newSession, send } from '../src/core/session'
import { loginHint } from '../src/commands/send'
import { oneLine } from '../src/adapters/types'
import provenanceData from '../tests/fixtures/streams/provenance.json'

const provenance = provenanceData as Record<AgentId, { cliVersion: string; capturedAt: string }>

// A fresh nonce per agent: distinctive enough that the second answer cannot be a cached greeting
// or a guess, short enough to invite no elaboration.
const nonce = (): string => Math.random().toString(16).slice(2, 8)
const storePrompt = (word: string): string => `The secret word is ${word}. Reply with only: stored`
const RECALL_PROMPT = 'What is the secret word? Reply with only the word.'
const DEFAULT_TIMEOUT_SEC = 120

export interface SmokeDeps {
  db: Database
  cfg: Config
  tmpDir: string
  adapterFor?: (agent: AgentId) => Adapter
  detectDeps?: DetectDeps
  timeoutSec?: number
  agents?: readonly AgentId[]
}

export type AgentOutcome =
  | { agent: AgentId; status: 'skipped'; reason: string }
  | {
      agent: AgentId
      status: 'ok'
      foreignId: string
      tokens: number
      resumed: boolean
      version: string | null
      versionDrift: string | null
    }
  | { agent: AgentId; status: 'failed'; reason: string }

function versionDrift(agent: AgentId, installed: string | null): string | null {
  const captured = provenance[agent]?.cliVersion
  if (!installed || !captured || installed === captured) return null
  return `installed ${installed}, fixtures captured from ${captured} — consider re-capturing tests/fixtures/streams/${agent}*.jsonl`
}

export async function runSmoke(deps: SmokeDeps): Promise<AgentOutcome[]> {
  const results: AgentOutcome[] = []

  for (const agent of deps.agents ?? agentIds) {
    const settings = resolveAgent(deps.cfg, agent)
    if (!settings.enabled) {
      results.push({ agent, status: 'skipped', reason: 'disabled in config' })
      continue
    }

    const detection = await detect(agent, { model: settings.model, bin: settings.bin, deps: deps.detectDeps })
    if (!detection.installed) {
      results.push({ agent, status: 'skipped', reason: 'not installed' })
      continue
    }

    const auth = await detectAuth(agent, { bin: settings.bin, deps: deps.detectDeps })
    if (auth.authed === false) {
      results.push({ agent, status: 'skipped', reason: `not logged in — ${loginHint(agent)}` })
      continue
    }

    const session = newSession(deps.db, { cwd: deps.tmpDir, goal: `konvoy smoke — ${agent}`, lead: agent })

    try {
      const opts = { timeoutSec: deps.timeoutSec ?? DEFAULT_TIMEOUT_SEC }
      const sendDeps = { db: deps.db, cfg: deps.cfg, adapterFor: deps.adapterFor }
      const word = nonce()
      const first = await send(sendDeps, session, agent, storePrompt(word), opts)

      const missing: string[] = []
      if (!first.foreignId) missing.push('no foreign session id captured')
      if (first.final.trim() === '') missing.push('no final text')
      if (first.error) missing.push(`${first.error.kind}: ${first.error.message}`)
      if (missing.length > 0) {
        results.push({ agent, status: 'failed', reason: missing.join('; ') })
        continue
      }

      // The binding now holds the agent's own id; this turn is resumed through it. An answer that
      // carries the nonce is the promise kept; anything else is a session that did not carry.
      const second = await send(sendDeps, session, agent, RECALL_PROMPT, opts)
      if (second.error) {
        results.push({ agent, status: 'failed', reason: `resume: ${second.error.kind}: ${second.error.message}` })
        continue
      }
      if (!second.final.includes(word)) {
        results.push({
          agent,
          status: 'failed',
          reason: `resume did not carry context — stored ${word}, got "${oneLine(second.final, 80)}"`,
        })
        continue
      }

      results.push({
        agent,
        status: 'ok',
        foreignId: first.foreignId!,
        tokens: first.inputTokens + first.outputTokens + second.inputTokens + second.outputTokens,
        resumed: true,
        version: detection.version,
        versionDrift: versionDrift(agent, detection.version),
      })
    } catch (error) {
      results.push({ agent, status: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return results
}

function formatOutcome(o: AgentOutcome): string {
  const label = o.agent.padEnd(8)
  if (o.status === 'ok') {
    const versionTag = o.version ? ` (v${o.version})` : ''
    const line = `[ok    ] ${label} ${o.foreignId} · ${o.tokens} tokens · resume carried context${versionTag}`
    return o.versionDrift ? `${line}\n         note: ${o.versionDrift}` : line
  }
  if (o.status === 'skipped') return `[skip  ] ${label} ${o.reason}`
  return `[fail  ] ${label} ${o.reason}`
}

async function makeTmpDir(): Promise<string> {
  const proc = Bun.spawnSync(['mktemp', '-d'])
  const dir = new TextDecoder().decode(proc.stdout).trim()
  if (proc.exitCode !== 0 || !dir) throw new Error('smoke: could not create a temp working directory')
  return dir
}

async function main(): Promise<number> {
  const tmpDir = await makeTmpDir()
  const db = openDb(':memory:')
  try {
    // cwd is the throwaway dir, not the repo — a project-level .konvoy/config.jsonc here would
    // otherwise leak into a run meant to be isolated. The global layer still applies, since that
    // is where a real agents.opencode.bin override (opencode has none on PATH) would live.
    const cfg = await loadConfig({ cwd: tmpDir })
    console.log('smoke — two live turns per installed, authenticated agent, the second resumed (spends real quota)\n')
    const results = await runSmoke({ db, cfg, tmpDir })
    for (const r of results) console.log(formatOutcome(r))

    const ok = results.filter((r) => r.status === 'ok').length
    const skipped = results.filter((r) => r.status === 'skipped').length
    const failed = results.filter((r) => r.status === 'failed').length
    console.log(`\n${ok} ok, ${skipped} skipped, ${failed} failed`)
    return failed > 0 ? 1 : 0
  } finally {
    db.close()
    Bun.spawnSync(['rm', '-rf', tmpDir])
  }
}

if (import.meta.main) {
  process.exit(await main())
}
