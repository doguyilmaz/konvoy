import { expect, test } from 'bun:test'
import { remainder, sessionBanner, turnRender, type RenderDeps } from '../src/render'
import type { KonvoyEvent } from '../src/types'

// What a user saw before this: eighteen lines of "  · Bash" with no target, no outcome and no
// timing, then silence until the whole answer appeared at once. konvoy already parsed the text,
// thinking and tool events out of every CLI's stream and threw all but the tool name away.
function harness(opts: { tty?: boolean; color?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  let clock = 1000
  const deps: RenderDeps = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    color: opts.color ?? false,
    tty: opts.tty ?? false,
    now: () => clock,
  }
  return { out, err, deps, tick: (ms: number) => (clock += ms) }
}

const feed = (view: { onEvent: (e: KonvoyEvent) => void }, events: KonvoyEvent[]): void => {
  for (const e of events) view.onEvent(e)
}

test('a tool line names what it touched, how it ended and how long it took', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'tool', name: 'Read', status: 'start', detail: 'src/auth.ts' })
  h.tick(240)
  view.onEvent({ t: 'tool', name: 'Read', status: 'ok' })
  expect(h.err.join('')).toBe('  ✓ Read  src/auth.ts  0.2s\n')
})

test('a failed tool is marked failed, which is the whole point of showing tools at all', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'tool', name: 'Bash', status: 'start', detail: 'maestro test .maestro/smoke.yaml' })
  h.tick(1400)
  view.onEvent({ t: 'tool', name: 'Bash', status: 'error' })
  expect(h.err.join('')).toBe('  ✗ Bash  maestro test .maestro/smoke.yaml  1.4s\n')
})

test('the answer streams as it arrives instead of appearing all at once at the end', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  feed(view, [
    { t: 'text', text: 'Switched the refresh ' },
    { t: 'text', text: 'to fire on 401.' },
  ])
  // written before any finish() call: that is what "streaming" has to mean
  expect(h.out.join('')).toBe('Switched the refresh to fire on 401.')
})

test('thinking is one quiet line, not a transcript of the reasoning', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  feed(view, [
    { t: 'thinking', text: 'The user wants maestro to run, so first I should check' },
    { t: 'thinking', text: ' whether the flows exist at all and then' },
    { t: 'text', text: 'Done.' },
  ])
  expect(h.err.join('')).toBe('  … thinking\n')
  expect(h.err.join('')).not.toContain('maestro')
})

test('an unsettled tool is closed out when the turn moves on, not left dangling', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'tool', name: 'Bash', status: 'start', detail: 'bun test' })
  h.tick(900)
  view.onEvent({ t: 'text', text: 'All 41 pass.' })
  expect(h.err.join('')).toBe('  · Bash  bun test  0.9s\n')
})

test('the footer says what the turn cost, in one line', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'text', text: 'OK' })
  h.tick(3100)
  view.finish({ inputTokens: 24400, outputTokens: 111, costUsd: 0.0621, credits: 0 })
  expect(h.err.join('')).toBe('  claude · 3.1s · 24.4k in / 111 out · $0.0621\n')
})

test('an agent that reports credits instead of dollars has its own unit in the footer', () => {
  const h = harness()
  const view = turnRender('kiro', h.deps)
  h.tick(2000)
  view.finish({ inputTokens: 4920, outputTokens: 930, costUsd: 0, credits: 0.19 })
  expect(h.err.join('')).toBe('  kiro · 2.0s · 4.9k in / 930 out · 0.190 cr\n')
})

// decideOutcome in src/commands/send.ts words every failure, knows the exit code and adds the
// login hint. The footer stating it too would be a second source for one sentence, which is the
// defect this project spent three commits removing from src/commands.
test('the footer reports cost and time only, leaving failures to the one place that words them', () => {
  const h = harness()
  const view = turnRender('codex', h.deps)
  h.tick(500)
  view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
  expect(h.err.join('')).toBe('  codex · 0.5s\n')
})

test('what was streamed is not printed a second time by the caller', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'text', text: 'the whole answer' })
  expect(view.streamed()).toBe('the whole answer')
  // every captured CLI stream carries its final in its text events, so this is the normal case
  expect(remainder('the whole answer', view.streamed())).toBe('')
  // an agent that only reports a final still gets it printed
  expect(remainder('only a final', '')).toBe('only a final')
  // and one that says more at the end than it streamed keeps the tail
  expect(remainder('streamed plus tail', 'streamed')).toBe(' plus tail')
})

test('a terminal gets a live line it rewrites; a pipe gets one clean line and no escapes', () => {
  const tty = harness({ tty: true })
  const view = turnRender('claude', tty.deps)
  view.onEvent({ t: 'tool', name: 'Read', status: 'start', detail: 'src/auth.ts' })
  expect(tty.err.join('')).toContain('Read')
  tty.tick(200)
  view.onEvent({ t: 'tool', name: 'Read', status: 'ok' })
  expect(tty.err.join('')).toContain('\r')

  const piped = harness({ tty: false })
  const plain = turnRender('claude', piped.deps)
  plain.onEvent({ t: 'tool', name: 'Read', status: 'start', detail: 'src/auth.ts' })
  piped.tick(200)
  plain.onEvent({ t: 'tool', name: 'Read', status: 'ok' })
  expect(piped.err.join('')).not.toContain('\r')
  expect(piped.err.join('')).not.toContain('\x1b')
})

test('colour is applied to the chrome and never to the agent own words', () => {
  const h = harness({ color: true })
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'tool', name: 'Read', status: 'start', detail: 'src/auth.ts' })
  view.onEvent({ t: 'tool', name: 'Read', status: 'ok' })
  view.onEvent({ t: 'text', text: 'the answer' })
  expect(h.err.join('')).toContain('\x1b[')
  // the model's own output is handed to the terminal exactly as it came
  expect(h.out.join('')).toBe('the answer')
})

// The report that led to all of this: a first-time user's MCP server was stripped by konvoy's own
// default and the agent told them to restart their CLI, and every tool call that needed approval
// was refused with nothing on screen to say so. konvoy knew both facts before the turn started.
test('the banner says what konvoy took away before the first turn runs', () => {
  const lines = sessionBanner(
    { version: '0.3.3', slug: 'test', dir: '/repo/.konvoy/test', agent: 'claude', harness: 'minimal', permission: 'edit' },
    false,
  ).join('\n')
  expect(lines).toContain('session test')
  expect(lines).toContain('/repo/.konvoy/test')
  expect(lines).toContain('harness minimal')
  expect(lines).toContain('MCP servers, skills or settings files')
  expect(lines).toContain('konvoy config set defaults.harness inherit --global')
  expect(lines).toContain('a tool that needs approval is refused')
})

test('the banner claims nothing about the two agents that do not read harness', () => {
  for (const agent of ['kiro', 'opencode'] as const) {
    const lines = sessionBanner(
      { version: '0.3.3', slug: 's', dir: '/d', agent, harness: 'minimal', permission: 'edit' },
      false,
    ).join('\n')
    expect(lines, agent).not.toContain('harness minimal')
  }
})

test('a session with nothing withheld gets a banner with no warnings in it', () => {
  const lines = sessionBanner(
    { version: '0.3.3', slug: 's', dir: '/d', agent: 'claude', harness: 'inherit', permission: 'yolo' },
    false,
  )
  expect(lines).toHaveLength(2)
  expect(lines.join('\n')).not.toContain('!')
})
