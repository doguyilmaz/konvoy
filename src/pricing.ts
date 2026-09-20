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
      return (row.inputTokens / 1_000_000) * rate.inputPerMTok +
        (row.outputTokens / 1_000_000) * rate.outputPerMTok
    }
  }

  return null
}
