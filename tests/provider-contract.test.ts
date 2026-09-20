import { expect, test } from 'bun:test'
import { agentIds, getAdapter } from '../src/adapters'
import provenance from './fixtures/streams/provenance.json'

// This project's most expensive lesson: three of the four adapters were written from guesses
// about wire formats, all three were wrong, and the tests stayed green because they tested the
// guess. Real streams were then captured into tests/fixtures/streams/. Nothing enforced that a
// fifth adapter ships with a captured fixture behind it — this does. Iterating `agentIds` (built
// from the actual adapters record, not a hand-kept list) means adding an adapter without adding
// its fixture fails here, not silently.
for (const id of agentIds) {
  test(`${id} has a captured stream fixture with declared provenance`, async () => {
    const path = `tests/fixtures/streams/${id}.jsonl`
    expect(await Bun.file(path).exists()).toBe(true)

    const meta = (provenance as Record<string, { cliVersion?: string; capturedAt?: string }>)[id]
    expect(meta, `no provenance entry for "${id}" in tests/fixtures/streams/provenance.json`).toBeDefined()
    expect(meta!.cliVersion, `${id}'s fixture does not declare which CLI version it was captured from`).toBeTruthy()
    expect(meta!.capturedAt, `${id}'s fixture does not declare when it was captured`).toBeTruthy()
  })

  test(`${id}'s adapter turns its captured fixture into at least one meaningful event`, async () => {
    const path = `tests/fixtures/streams/${id}.jsonl`
    const lines = (await Bun.file(path).text()).trim().split('\n')
    const adapter = getAdapter(id)
    const events = lines.flatMap((line) => adapter.parse(line))
    expect(events.length).toBeGreaterThan(0)
    // "meaningful" rules out a fixture/adapter pairing that only ever yields error events
    expect(events.some((e) => e.t !== 'error')).toBe(true)
  })

  // The adapters agree on the field names and disagree on what they mean: claude's
  // input_tokens excludes both cache fields, codex's already contains cached_input_tokens.
  // Reading each CLI's headline field therefore filled one normalized column with two units,
  // which src/pricing.ts prices per million and src/dashboard/page.ts adds across agents.
  // Whatever an adapter reports as inputTokens, it cannot be smaller than a single component
  // of the context that CLI says it sent — that holds under either convention, needs no
  // per-agent table, and is what a fifth adapter inherits by existing.
  test(`${id} reports input tokens no smaller than any context component in its fixture`, async () => {
    const raw = await Bun.file(`tests/fixtures/streams/${id}.jsonl`).text()
    const components = [...raw.matchAll(/"([a-z_]*(?:input|cache)[a-z_]*)":\s*(\d+)/g)]
      .filter(([, name]) => !name!.includes('output'))
      .map(([, name, value]) => ({ name: name!, value: Number(value) }))
    if (components.length === 0) return // this CLI reports no usage; nothing to contradict

    const adapter = getAdapter(id)
    const reported = raw
      .trim()
      .split('\n')
      .flatMap((line) => adapter.parse(line))
      .reduce((sum, e) => (e.t === 'usage' ? sum + (e.inputTokens ?? 0) : sum), 0)

    const largest = components.reduce((a, b) => (b.value > a.value ? b : a))
    expect(reported, `${id} reports ${reported} input tokens but its own stream names ${largest.name}=${largest.value}`)
      .toBeGreaterThanOrEqual(largest.value)
  })
}
