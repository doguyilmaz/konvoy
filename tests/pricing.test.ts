import { expect, test } from 'bun:test'
import { estimateUsd } from '../src/pricing'

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
