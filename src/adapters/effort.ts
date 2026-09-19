import type { Effort } from '../types'

const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export function clampEffort(requested: Effort, supported?: readonly string[]): { value: string; clamped: boolean } {
  if (!supported || supported.length === 0) return { value: requested, clamped: false }
  if (supported.includes(requested)) return { value: requested, clamped: false }
  const wanted = LADDER.indexOf(requested as (typeof LADDER)[number])
  const ranked = supported
    .map((s) => ({ s, i: LADDER.indexOf(s as (typeof LADDER)[number]) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
  if (ranked.length === 0) return { value: supported[0]!, clamped: true }
  const below = ranked.filter((x) => x.i < wanted).pop()
  return { value: (below ?? ranked[0]!).s, clamped: true }
}
