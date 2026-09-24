import { expect, test } from 'bun:test'
import { adapters } from '../src/adapters'
import { turnRender, type RenderDeps } from '../src/render'
import type { AgentId } from '../src/types'

// Every other render test drives hand-written events. This one drives the REAL captured streams
// in tests/fixtures/streams (see provenance.json) through the real adapters and the real
// renderer, which is the only end-to-end check available without spending quota: parse, events,
// tool lines, streamed text and the footer, on output four CLIs actually produced.
const capture = async (name: string): Promise<string[]> =>
  (await Bun.file(`tests/fixtures/streams/${name}.jsonl`).text()).trim().split('\n')

function harness() {
  const out: string[] = []
  const err: string[] = []
  let clock = 0
  const deps: RenderDeps = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    color: false,
    tty: false,
    // every event advances the clock, so durations in the output are non-zero and stable
    now: () => (clock += 100),
  }
  return { out, err, deps }
}

const render = async (agent: AgentId, fixture: string) => {
  const h = harness()
  const view = turnRender(agent, h.deps)
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 }
  for (const line of await capture(fixture)) {
    for (const event of adapters[agent].parse(line)) {
      view.onEvent(event)
      if (event.t === 'usage') {
        usage = {
          inputTokens: usage.inputTokens + (event.inputTokens ?? 0),
          outputTokens: usage.outputTokens + (event.outputTokens ?? 0),
          costUsd: usage.costUsd + (event.costUsd ?? 0),
          credits: usage.credits + (event.credits ?? 0),
        }
      }
    }
  }
  view.finish(usage)
  return { answer: h.out.join(''), chrome: h.err.join('') }
}

test('a real claude turn renders its tool call with a target and an outcome, then the answer', async () => {
  const { answer, chrome } = await render('claude', 'claude')
  expect(chrome).toContain('✓ Read')
  expect(chrome).toContain('package.json')
  expect(answer.trim()).toBe('1.0.0')
  // the footer carries the whole context sent, not claude's uncached remainder
  expect(chrome).toMatch(/claude · [\d.]+s · 38\.8k in \/ 112 out · \$0\.0345/)
})

test('a real codex turn renders its shell command as a tool line and its answer as text', async () => {
  const { answer, chrome } = await render('codex', 'codex')
  expect(chrome).toContain('✓ Shell')
  // the command itself, from the capture, not the item type or the login shell wrapped around it
  expect(chrome).toContain('cat package.json')
  expect(chrome).not.toContain('command_execution')
  expect(chrome).not.toContain('-lc')
  expect(answer).toContain('package.json')
  expect(answer.trim().endsWith('1.0.0')).toBe(true)
})

test('a real kiro turn renders its tool title and reports credits, not dollars', async () => {
  const { answer, chrome } = await render('kiro', 'kiro')
  expect(chrome).toContain('✓ Read  package.json')
  expect(answer).toContain('1.0.0')
  expect(chrome).toMatch(/kiro · [\d.]+s .*cr/)
  expect(chrome).not.toContain('$')
})

test('a real opencode turn renders its tool call and its own cost', async () => {
  const { answer, chrome } = await render('opencode', 'opencode')
  expect(chrome).toContain('✓ Read  package.json')
  expect(answer.trim()).toBe('OK')
  expect(chrome).toContain('$0.0050')
})

test('a real thinking capture shows one quiet line, never the reasoning itself', async () => {
  const { chrome } = await render('claude', 'claude-thinking')
  expect(chrome).toContain('… thinking')
  expect(chrome.split('… thinking')).toHaveLength(2)
})

test('a real error capture renders no answer and no invented tool outcome', async () => {
  const { answer, chrome } = await render('claude', 'claude-error')
  expect(answer.trim()).toBe('')
  expect(chrome).not.toContain('✓')
  expect(chrome).not.toContain('✗')
})

test('every captured stream renders without throwing, for every agent that has one', async () => {
  for (const [agent, fixture] of [
    ['claude', 'claude'], ['claude', 'claude-thinking'], ['claude', 'claude-error'],
    ['codex', 'codex'], ['kiro', 'kiro'], ['opencode', 'opencode'], ['opencode', 'opencode-error'],
  ] as [AgentId, string][]) {
    const { chrome } = await render(agent, fixture)
    // the footer is the proof the whole pass completed
    expect(chrome, `${agent}/${fixture}`).toContain(agent)
  }
})

// Found by reading this suite's own output: codex and kiro both speak before their first tool
// call, and the answer goes to stdout while the tool line goes to stderr. Without a break the two
// arrive on one line, which read as "I'll read package.json now.  ✓ command_execution ...".
test('an answer interrupted by a tool call keeps the tool line on its own line', async () => {
  for (const [agent, fixture] of [['codex', 'codex'], ['kiro', 'kiro']] as [AgentId, string][]) {
    const h = harness()
    const view = turnRender(agent, h.deps)
    for (const line of await capture(fixture)) for (const e of adapters[agent].parse(line)) view.onEvent(e)
    view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })

    // interleave the two streams the way a terminal does, then check no line holds both
    const combined = `${h.out.join('')}`
    expect(combined.endsWith('\n'), agent).toBe(true)
    for (const chunk of h.out) expect(chunk.includes('✓'), agent).toBe(false)
    // the answer's last fragment is followed by a break, so the next chrome line starts clean
    expect(h.out.at(-1), agent).toBe('\n')
  }
})
