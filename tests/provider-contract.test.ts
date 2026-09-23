import { expect, test } from 'bun:test'
import { agentIds, getAdapter } from '../src/adapters'
import type { AgentId } from '../src/types'
import provenance from './fixtures/streams/provenance.json'

// Kinds an adapter can emit for which no captured stream exists, each with the reason. Listed
// here, in the open, so a reader judges the gap instead of trusting a silent skip.
const UNCAPTURED: Partial<Record<AgentId, Record<string, string>>> = {
  codex: { thinking: 'display-only; codex emits reasoning items only for some models and prompts' },
  kiro: {
    thinking: 'display-only; not deterministic to trigger',
    error: 'kiro fails outside the stream (stderr, exit 1) - no runFinished failure has been captured',
  },
  opencode: { thinking: 'display-only; not deterministic to trigger' },
  antigravity: {
    error:
      'agy reports SUCCESS for almost everything, including an auto-denied tool and a missing conversation (both captured, both surfaced through Adapter.warnings). The one ERROR result observed came from a transient 503 on its eligibility check and cannot be forced; capture it if it recurs',
  },
}

// This project's most expensive lesson: three of the four adapters were written from guesses
// about wire formats, all three were wrong, and the tests stayed green because they tested the
// guess. Real streams were then captured into tests/fixtures/streams/. Nothing enforced that a
// fifth adapter ships with a captured fixture behind it - this does. Iterating `agentIds` (built
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

  // opencode's adapter parsed usage from a step_finish event, its fixture was captured from a
  // turn that called no tools, and opencode only emits step_finish once a step does tool work.
  // So the branch never ran, its own test asserted usage was absent, and konvoy recorded zero
  // tokens and zero cost for every opencode turn while opencode was reporting both. A fixture
  // that cannot reach a branch is not coverage - this makes an adapter's own source say which
  // branches its fixture owes, so a capture taken from too simple a turn fails here.
  test(`${id}'s fixture exercises the usage path its adapter implements`, async () => {
    const source = await Bun.file(`src/adapters/${id}.ts`).text()
    if (!source.includes("t: 'usage'")) return // this adapter claims no usage path to exercise

    const lines = (await Bun.file(`tests/fixtures/streams/${id}.jsonl`).text()).trim().split('\n')
    const adapter = getAdapter(id)
    const usage = lines.flatMap((line) => adapter.parse(line)).filter((e) => e.t === 'usage')
    expect(usage.length, `src/adapters/${id}.ts parses usage but ${id}.jsonl never produces one - capture a turn that does`)
      .toBeGreaterThan(0)
  })

  // Every event kind an adapter can emit must be produced by a captured stream - its main
  // fixture or its `-error` one. Today's opencode usage bug and the unreached `tool` branches
  // in three adapters were one defect: a branch written from the wire-format guess and a fixture
  // from a turn too simple to reach it. A unit test cannot see this, because it feeds the branch
  // the guess. This reads the adapter's own source for what it can emit and demands a capture.
  test(`${id}: every event kind its adapter can emit is reached by a captured stream`, async () => {
    const source = await Bun.file(`src/adapters/${id}.ts`).text()
    const canEmit = new Set([...source.matchAll(/t: '([a-z]+)'/g)].map((m) => m[1]!))
    const adapter = getAdapter(id)
    const reached = new Set<string>()
    // every capture this adapter owns: `<id>.jsonl` and any `<id>-<what>.jsonl`
    const own = new RegExp(`^${id}(-[a-z0-9-]+)?\\.jsonl$`)
    for await (const name of new Bun.Glob('*.jsonl').scan({ cwd: 'tests/fixtures/streams' })) {
      if (!own.test(name)) continue
      const lines = (await Bun.file(`tests/fixtures/streams/${name}`).text()).trim().split('\n')
      for (const line of lines) for (const e of adapter.parse(line)) reached.add(e.t)
    }
    const excused = UNCAPTURED[id] ?? {}
    const missing = [...canEmit].filter((k) => !reached.has(k) && !(k in excused)).sort()
    expect(missing, `${id} can emit ${missing.join(', ')} but no captured stream reaches it - capture a turn that does, or excuse it in UNCAPTURED with the reason`).toEqual([])
  })

  // The adapters agree on the field names and disagree on what they mean: claude's
  // input_tokens excludes both cache fields, codex's already contains cached_input_tokens.
  // Reading each CLI's headline field therefore filled one normalized column with two units,
  // which src/pricing.ts prices per million and src/dashboard/page.ts adds across agents.
  // Whatever an adapter reports as inputTokens, it cannot be smaller than a single component
  // of the context that CLI says it sent - that holds under either convention, needs no
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
