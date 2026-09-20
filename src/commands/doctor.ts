import type { Config } from '../config/schema'
import { agentIds, getAdapter } from '../adapters'
import type { AgentId } from '../types'
import { resolveAgent } from '../config/load'
import { detect, detectAuth, type DetectDeps } from '../core/detect'
import { clampEffort } from '../adapters/effort'
import { loginHint } from './send'

// `which -a` prints one line per PATH entry, so a directory listed twice repeats the same path
export function distinctPaths(stdout: string): string[] {
  return [...new Set(stdout.trim().split('\n').filter(Boolean))]
}

// engine, policy.maxDelegationDepth and policy.isolation are in the schema and the spec, but
// nothing reads them yet — the delegation work will. Comparing the parsed policy values against
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

export async function cmdDoctor(cfg: Config, deps?: DetectDeps): Promise<number> {
  let problems = 0
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
        console.log(`x ${agent}: disabled in config but named by a role`)
        problems++
      } else {
        console.log(`- ${agent}: disabled in config`)
      }
      continue
    }

    const d = await detect(agent, { model: settings.model, bin: settings.bin, deps })
    if (!d.installed) {
      if (required.has(agent)) {
        console.log(`x ${agent}: not installed`)
        problems++
      } else {
        console.log(`- ${agent}: not installed`)
      }
      continue
    }
    const auth = await detectAuth(agent, { bin: settings.bin, deps })
    if (auth.authed === false) {
      if (required.has(agent)) {
        console.log(`x ${agent}: ${auth.detail} — ${loginHint(agent)}`)
        problems++
      } else {
        console.log(`- ${agent}: ${auth.detail} — ${loginHint(agent)}`)
      }
      continue
    }

    const clamp = clampEffort(settings.effort, d.efforts)
    if (clamp.clamped) {
      console.log(`! ${agent}: effort "${settings.effort}" is unsupported here, using "${clamp.value}"`)
    }

    if (agent === 'opencode' && !settings.model) {
      console.log(`! opencode: no model configured — it returns HTTP 403 without an explicit -m`)
    }

    const shadow = Bun.spawnSync(['which', '-a', settings.bin ?? getAdapter(agent).bin])
    const paths = distinctPaths(new TextDecoder().decode(shadow.stdout))
    if (paths.length > 1 && !settings.bin) {
      console.log(`! ${agent}: ${paths.length} binaries on PATH, "${paths[0]}" wins — set agents.${agent}.bin to be explicit`)
    }

    if (settings.model) {
      models.set(settings.model, [...(models.get(settings.model) ?? []), agent])
    }
    console.log(`ok ${agent}: ${d.version}${settings.model ? ` (${settings.model})` : ''}`)
  }

  for (const [model, users] of models) {
    if (users.length > 1) {
      console.log(`! ${users.join(' and ')} both run ${model} — they will not disagree with each other`)
    }
  }

  const unused = acceptedButUnusedKeys(cfg)
  if (unused.length > 0) {
    console.log(`i ${unused.join(', ')} — accepted but not yet used`)
  }

  console.log(problems === 0 ? '\nno problems found' : `\n${problems} problem(s) found`)
  return problems === 0 ? 0 : 1
}
