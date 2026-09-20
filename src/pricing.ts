import type { AgentId } from './types'
import type { Config } from './config/schema'

export type Pricing = Config['pricing']

export interface Priced {
  agent: AgentId
  model: string | null
  inputTokens: number
  outputTokens: number
  credits: number
}

export function estimateUsd(row: Priced, pricing: Pricing): number | null {
  // An agent bills one way or the other, never both. Kiro reports token counts alongside the
  // credits it actually charges, so pricing its model as well would double the row.
  if (row.credits > 0) {
    const rate = pricing.credits[row.agent]
    if (rate) return row.credits * rate.usdPerCredit
  }

  if (row.model) {
    const rate = pricing.models[row.model]
    if (rate) {
      // inputTokens is the whole context sent, cache reads included, and those bill at a
      // tenth of this rate — so a cache-heavy turn estimates high. Only turns whose CLI
      // reported no cost of its own reach here, which today is never claude's.
      return (row.inputTokens / 1_000_000) * rate.inputPerMTok +
        (row.outputTokens / 1_000_000) * rate.outputPerMTok
    }
  }

  return null
}

// pricing defaults to empty, so an unconfigured user must never see a ~USD column of dashes —
// the column exists only once there's at least one rate to estimate from
export function isPricingConfigured(pricing: Pricing): boolean {
  return Object.keys(pricing.models).length > 0 || Object.keys(pricing.credits).length > 0
}

export interface ModelUsage {
  agent: AgentId
  model: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  credits: number
}

// Summed per model, never priced once on the aggregate: a session that ran half its turns on
// an expensive model and half on a cheap one must not be priced as though it used either one
// throughout — that's the whole reason `model` lives on the turn instead of the binding.
export function estimateAgentUsd(agent: AgentId, rows: ModelUsage[], pricing: Pricing): number | null {
  const mine = rows.filter((r) => r.agent === agent)
  // An agent bills one way or the other. Kiro charges credits and reports token counts beside
  // them for information; codex and opencode report only tokens. Deciding per agent rather than
  // per row is what keeps a kiro turn that charged no credits from reading as unpriceable, and
  // a codex turn with real tokens and no model from reading as free.
  const billsInCredits = mine.some((r) => r.credits > 0)

  let total = 0
  for (const row of mine) {
    if (row.costUsd > 0) {
      total += row.costUsd
      continue
    }

    if (billsInCredits) {
      if (row.credits === 0) continue
      const rate = pricing.credits[agent]
      if (!rate) return null
      total += row.credits * rate.usdPerCredit
      continue
    }

    if (row.inputTokens === 0 && row.outputTokens === 0) continue
    const est = estimateUsd(
      { agent, model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, credits: row.credits },
      pricing,
    )
    if (est === null) return null
    total += est
  }
  return total
}
