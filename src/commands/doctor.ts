import type { Config } from '../config/schema'
import { agentIds, getAdapter } from '../adapters'
import type { AgentId } from '../types'
import { resolveAgent } from '../config/load'
import { detect, detectAuth } from '../core/detect'
import { clampEffort } from '../adapters/effort'
import { loginHint } from './send'

export async function cmdDoctor(cfg: Config): Promise<number> {
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
      console.log(`- ${agent}: disabled in config`)
      continue
    }

    const d = await detect(agent, settings.model)
    if (!d.installed) {
      console.log(`x ${agent}: not installed`)
      if (required.has(agent)) problems++
      continue
    }
    const auth = await detectAuth(agent, settings.bin)
    if (auth.authed === false) {
      console.log(`x ${agent}: ${auth.detail} — ${loginHint(agent)}`)
      if (required.has(agent)) problems++
    }

    const clamp = clampEffort(settings.effort, d.efforts)
    if (clamp.clamped) {
      console.log(`! ${agent}: effort "${settings.effort}" is unsupported here, using "${clamp.value}"`)
    }

    if (agent === 'opencode' && !settings.model) {
      console.log(`! opencode: no model configured — it returns HTTP 403 without an explicit -m`)
    }

    const shadow = Bun.spawnSync(['which', '-a', settings.bin ?? getAdapter(agent).bin])
    const paths = new TextDecoder().decode(shadow.stdout).trim().split('\n').filter(Boolean)
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

  const lead = cfg.roles.lead ?? 'claude'
  if (!resolveAgent(cfg, lead).enabled) {
    console.log(`x lead agent "${lead}" is disabled`)
    problems++
  }

  console.log(problems === 0 ? '\nno problems found' : `\n${problems} problem(s) found`)
  return problems === 0 ? 0 : 1
}
