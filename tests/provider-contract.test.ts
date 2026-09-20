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
}
