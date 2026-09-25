import type { Config } from '../config/schema'
import { agentIds, getAdapter } from '../adapters'
import type { AgentId } from '../types'
import { resolveAgent } from '../config/load'
import { detect, detectAuth, type DetectDeps } from '../core/detect'
import { clampEffort } from '../adapters/effort'
import { loginHint } from './send'
import { colorEnabled, palette } from '../style'
import { join } from '../paths'

// `which -a` prints one line per PATH entry, so a directory listed twice repeats the same path
export function distinctPaths(stdout: string): string[] {
  return [...new Set(stdout.trim().split('\n').filter(Boolean))]
}

// engine, policy.maxDelegationDepth and policy.isolation are in the schema and the spec, but
// nothing reads them yet - the delegation work will. Comparing the parsed policy values against
// their schema defaults is an approximation (a value set explicitly equal to the default reads
// as unset), acceptable for an informational line with no behavioural effect.
export function acceptedButUnusedKeys(cfg: Config): string[] {
  const keys: string[] = []
  if (cfg.policy.maxDelegationDepth !== 3) keys.push('policy.maxDelegationDepth')
  if (cfg.policy.isolation !== 'serial') keys.push('policy.isolation')
  for (const agent of agentIds) {
    if (cfg.agents[agent]?.engine !== undefined) keys.push(`agents.${agent}.engine`)
  }
  return keys
}

// One glyph set for the whole report, in one column: a problem, a warning, a healthy agent, a
// note. The same report used to mix `ok `, `x `, `- `, `! ` and `i `, so nothing lined up and the
// agent's name sat mid-sentence. Colour follows the glyph and is dropped on a pipe.
const GLYPH = { bad: '✗', warn: '!', good: '✓', note: '·' } as const

function reporter(): (kind: keyof typeof GLYPH, text: string) => void {
  const p = palette(colorEnabled(Bun.env, Boolean(process.stdout.isTTY)))
  const paint = { bad: p.red, warn: p.yellow, good: p.green, note: p.dim } as const
  return (kind, text) => console.log(`${paint[kind](GLYPH[kind])}  ${text}`)
}

// Every binary named `bin` on PATH, in PATH order. Read from the directories themselves rather
// than from `which -a`, which a minimal system may not have: the one tool doctor needs is konvoy.
export async function binariesOnPath(bin: string, path: string = Bun.env.PATH ?? ''): Promise<string[]> {
  if (bin.includes('/')) return [bin]
  const found: string[] = []
  for (const dir of path.split(':').filter(Boolean)) {
    const candidate = join(dir, bin)
    if (await Bun.file(candidate).exists()) found.push(candidate)
  }
  return distinctPaths(found.join('\n'))
}

type Finding = { kind: keyof typeof GLYPH; text: string; problem?: boolean; model?: string }

export async function cmdDoctor(cfg: Config, deps?: DetectDeps): Promise<number> {
  const say = reporter()
  const models = new Map<string, string[]>()
  const required = new Set<AgentId>(
    [cfg.roles.lead ?? 'claude', cfg.roles.implementer, cfg.roles.reviewer, cfg.roles.researcher].filter(
      (a): a is AgentId => a !== undefined,
    ),
  )

  // Each agent's checks spawn its CLI up to twice; run one after another, five slow node CLIs
  // made doctor take as long as all of them together. They run at once and report in order.
  const examine = async (agent: AgentId): Promise<Finding[]> => {
    const settings = resolveAgent(cfg, agent)
    const severity = (text: string): Finding => (required.has(agent) ? { kind: 'bad', text, problem: true } : { kind: 'note', text })
    if (!settings.enabled) {
      return [required.has(agent) ? { kind: 'bad', text: `${agent}: disabled in config but named by a role`, problem: true } : { kind: 'note', text: `${agent}: disabled in config` }]
    }

    const d = await detect(agent, { model: settings.model, bin: settings.bin, deps })
    if (!d.installed) return [severity(`${agent}: not installed - konvoy install ${agent}`)]
    const auth = await detectAuth(agent, { bin: settings.bin, deps })
    if (auth.authed === false) return [severity(`${agent}: ${auth.detail} - ${loginHint(agent)}`)]

    const findings: Finding[] = []
    const clamp = clampEffort(settings.effort, d.efforts)
    if (clamp.clamped) {
      findings.push({ kind: 'warn', text: `${agent}: effort "${settings.effort}" is unsupported here, using "${clamp.value}"` })
    }

    if (agent === 'opencode' && !settings.model) {
      findings.push({ kind: 'warn', text: 'opencode: no model configured - it returns HTTP 403 without an explicit -m' })
    }

    const paths = await binariesOnPath(settings.bin ?? getAdapter(agent).bin)
    if (paths.length > 1 && !settings.bin) {
      findings.push({ kind: 'warn', text: `${agent}: ${paths.length} binaries on PATH, "${paths[0]}" wins - set agents.${agent}.bin to be explicit` })
    }

    findings.push({ kind: 'good', text: `${agent}: ${d.version}${settings.model ? ` (${settings.model})` : ''}`, model: settings.model })
    return findings
  }

  let problems = 0
  const results = await Promise.all(agentIds.map(async (agent) => ({ agent, findings: await examine(agent) })))
  for (const { agent, findings } of results) {
    for (const f of findings) {
      say(f.kind, f.text)
      if (f.problem) problems++
      if (f.model) models.set(f.model, [...(models.get(f.model) ?? []), agent])
    }
  }

  for (const [model, users] of models) {
    if (users.length > 1) {
      say('warn', `${users.join(' and ')} both run ${model} - they will not disagree with each other`)
    }
  }

  const unused = acceptedButUnusedKeys(cfg)
  if (unused.length > 0) {
    say('note', `${unused.join(', ')} - accepted but not yet used`)
  }

  console.log(problems === 0 ? '\nno problems found' : `\n${problems} problem${problems === 1 ? '' : 's'} found`)
  return problems === 0 ? 0 : 1
}
