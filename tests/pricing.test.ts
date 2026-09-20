import { expect, test } from 'bun:test'
import { configSchema } from '../src/config/schema'
import { estimateAgentUsd, estimateUsd } from '../src/pricing'

const pricing = {
  asOf: '2026-09-19',
  models: { opus: { inputPerMTok: 15, outputPerMTok: 75 } },
  credits: { kiro: { usdPerCredit: 0.02 } },
}

test('a priced model estimates from its tokens', () => {
  const got = estimateUsd(
    { agent: 'claude', model: 'opus', inputTokens: 1_000_000, outputTokens: 100_000, credits: 0 },
    pricing,
  )
  expect(got).toBeCloseTo(15 + 7.5)
})

test('credits are priced per agent', () => {
  const got = estimateUsd(
    { agent: 'kiro', model: null, inputTokens: 0, outputTokens: 0, credits: 10 },
    pricing,
  )
  expect(got).toBeCloseTo(0.2)
})

test('an unpriced model estimates to null, never to zero', () => {
  expect(
    estimateUsd({ agent: 'codex', model: 'gpt-6-astra', inputTokens: 1000, outputTokens: 10, credits: 0 }, pricing),
  ).toBe(null)
})

test('a credit-billed row is not also priced by its model', () => {
  // kiro reports token counts next to the credits it actually charges; pricing both doubles it
  const both = { asOf: '', models: { 'kiro-model': { inputPerMTok: 15, outputPerMTok: 75 } }, credits: { kiro: { usdPerCredit: 0.02 } } }
  const got = estimateUsd(
    { agent: 'kiro', model: 'kiro-model', inputTokens: 1_000_000, outputTokens: 0, credits: 10 },
    both,
  )
  expect(got).toBeCloseTo(0.2)
})

test('no rates at all means no estimate', () => {
  expect(
    estimateUsd({ agent: 'claude', model: 'opus', inputTokens: 1000, outputTokens: 10, credits: 0 }, { asOf: '', models: {}, credits: {} }),
  ).toBe(null)
})

test('tokens that could not be priced report nothing, not nothing spent', () => {
  // an agent with no model configured records model: null, which is the DEFAULT — not a
  // legacy row. Reporting $0.00 for real tokens says they were free; a dash says we cannot say.
  const rows = [{ agent: 'codex' as const, model: null, inputTokens: 4500, outputTokens: 1800, costUsd: 0, credits: 0 }]
  expect(estimateAgentUsd('codex', rows, pricing)).toBe(null)
})

test('a row that consumed nothing at all still contributes nothing', () => {
  const rows = [{ agent: 'codex' as const, model: null, inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 }]
  expect(estimateAgentUsd('codex', rows, pricing)).toBe(0)
})

// An agent bills in credits or in tokens, never both — the comment above estimateUsd says so,
// and format.ts's spend() relies on it. A credits row with no configured credit rate must
// estimate to null (unknown), not fall through to a token price for a model the agent is not
// billed by: kiro at 5 credits was showing ~USD $3.000 from claude-sonnet-5's token rate.
test('credits with no configured rate estimate to null rather than falling through to model pricing', () => {
  const pricing = configSchema.parse({ pricing: { models: { 'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 } } } }).pricing
  expect(estimateUsd({ agent: 'kiro', model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0, credits: 5 }, pricing)).toBeNull()
})
