import type { Config } from '../config/schema'
import { agentIds, getAdapter } from '../adapters'
import type { AgentId } from '../types'
import { resolveAgent } from '../config/load'
import { detect, detectAuth, type DetectDeps } from '../core/detect'
import { clampEffort } from '../adapters/effort'
import { loginHint } from './send'
import { colorEnabled, palette } from '../style'

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

export async function cmdDoctor(cfg: Config, deps?: DetectDeps): Promise<number> {
  let problems = 0
  const say = reporter()
  const models = new Map<string, string[]>()
  const required = new Set<AgentId>(
    [cfg.roles.lead ?? 'claude', cfg.roles.implementer, cfg.roles.reviewer, cfg.roles.researcher].filter(
      (a): a is AgentId => a !== undefined,
    ),
  )

  for (const agent of agentIds) {
    const settings = resolveAgent(cfg, agent)
    if (!settings.enabled) {
      if (required.has(agent)) {
        say('bad', `${agent}: disabled in config but named by a role`)
        problems++
      } else {
        say('note', `${agent}: disabled in config`)
      }
      continue
    }

    const d = await detect(agent, { model: settings.model, bin: settings.bin, deps })
    if (!d.installed) {
      if (required.has(agent)) {
        say('bad', `${agent}: not installed`)
        problems++
      } else {
        say('note', `${agent}: not installed`)
      }
      continue
    }
    const auth = await detectAuth(agent, { bin: settings.bin, deps })
    if (auth.authed === false) {
      if (required.has(agent)) {
        say('bad', `${agent}: ${auth.detail} - ${loginHint(agent)}`)
        problems++
      } else {
        say('note', `${agent}: ${auth.detail} - ${loginHint(agent)}`)
      }
      continue
    }

    const clamp = clampEffort(settings.effort, d.efforts)
    if (clamp.clamped) {
      say('warn', `${agent}: effort "${settings.effort}" is unsupported here, using "${clamp.value}"`)
    }

    if (agent === 'opencode' && !settings.model) {
      say('warn', 'opencode: no model configured - it returns HTTP 403 without an explicit -m')
    }

    const shadow = Bun.spawnSync(['which', '-a', settings.bin ?? getAdapter(agent).bin])
    const paths = distinctPaths(new TextDecoder().decode(shadow.stdout))
    if (paths.length > 1 && !settings.bin) {
      say('warn', `${agent}: ${paths.length} binaries on PATH, "${paths[0]}" wins - set agents.${agent}.bin to be explicit`)
    }

    if (settings.model) {
      models.set(settings.model, [...(models.get(settings.model) ?? []), agent])
    }
    say('good', `${agent}: ${d.version}${settings.model ? ` (${settings.model})` : ''}`)
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

  console.log(problems === 0 ? '\nno problems found' : `\n${problems} problem(s) found`)
  return problems === 0 ? 0 : 1
}
