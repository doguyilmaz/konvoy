import { expect, test } from 'bun:test'
import { duration, limitNotice, remainder, sessionBanner, statusLine, tokens, turnRender, type RenderDeps } from '../src/render'
import type { KonvoyEvent } from '../src/types'
import { Screen } from './fixtures/vt'

const SYNC = /\x1b\[\?2026[hl]/g

// What a user saw before this: eighteen lines of "  · Bash" with no target, no outcome and no
// timing, then silence until the whole answer appeared at once. konvoy already parsed the text,
// thinking and tool events out of every CLI's stream and threw all but the tool name away.
function harness(opts: { tty?: boolean; outTty?: boolean; color?: boolean; columns?: number; hint?: string } = {}) {
  const out: string[] = []
  const err: string[] = []
  // one terminal behind both streams, the way a person's shell is
  const screen = new Screen(opts.columns ?? 80)
  let clock = 1000
  const deps: RenderDeps = {
    out: (t) => {
      out.push(t)
      screen.write(t)
    },
    err: (t) => {
      err.push(t)
      screen.write(t)
    },
    color: opts.color ?? false,
    tty: opts.tty ?? false,
    outTty: opts.outTty ?? false,
    now: () => clock,
    columns: () => opts.columns ?? 80,
    ...(opts.hint ? { hint: opts.hint } : {}),
  }
  return { out, err, deps, screen, tick: (ms: number) => (clock += ms) }
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
  // the box and nothing after it
  expect(lines[0]).toStartWith('╭')
  expect(lines.at(-1)).toStartWith('╰')
  expect(lines.join('\n')).not.toContain('!')
})

test('the banner box is one width all the way down, whatever its rows hold', () => {
  const lines = sessionBanner(
    {
      version: '0.4.0', slug: 'sinkaf-8f3a', dir: '/repo/.konvoy/sinkaf-8f3a', agent: 'claude', harness: 'inherit',
      permission: 'auto', model: 'opus', effort: 'high', goal: 'fix the token refresh',
      roster: [{ agent: 'claude', ready: true }, { agent: 'codex', ready: false }],
    },
    true,
  )
  const box = lines.filter((l) => /^(\x1b\[[\d;]*m)*[╭│╰]/.test(l))
  const widths = new Set(box.map((l) => new Screen(200).write(l).text().length))
  expect(widths.size).toBe(1)
  const text = new Screen(200).write(lines.join('\n')).text()
  expect(text).toContain('konvoy 0.4.0')
  expect(text).toContain('sinkaf-8f3a · fix the token refresh')
  expect(text).toContain('claude · opus · high · auto')
  expect(text).toContain('● claude  ○ codex')
})

test('a banner narrower than its content is cut inside the box, never past its edge', () => {
  const lines = sessionBanner(
    { version: '0.4.0', slug: 's', dir: `/${'very-long-directory/'.repeat(8)}`, agent: 'claude', harness: 'inherit', permission: 'auto', columns: 50 },
    false,
  )
  for (const line of lines.filter((l) => /^[╭│╰]/.test(l))) expect(line.length).toBeLessThanOrEqual(50)
})

// "i dont see anything happens even when thinking": a tool that runs for ninety seconds has to
// look alive. The frame and the elapsed time are redrawn in place, and only on a terminal.
test('a running tool line animates in place and carries its own elapsed time', () => {
  const h = harness({ tty: true })
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'tool', name: 'Bash', status: 'start', detail: 'maestro test' })
  const frames: string[] = []
  for (let i = 0; i < 4; i++) {
    h.tick(500)
    h.err.length = 0
    view.tick()
    frames.push(h.err.join(''))
  }
  // each redraw returns to the start of the line, and no two consecutive frames look the same
  for (const frame of frames) expect(frame.replace(SYNC, '').startsWith('\r')).toBe(true)
  expect(new Set(frames.map((f) => f.replace(/[\d.]+s/, ''))).size).toBe(4)
  expect(frames[1]).toContain('1.0s')
  expect(frames[3]).toContain('2.0s')
  expect(frames[3]).toContain('maestro test')
})

test('nothing animates on a pipe, and nothing animates when no tool is running', () => {
  const piped = harness({ tty: false })
  const plain = turnRender('claude', piped.deps)
  plain.onEvent({ t: 'tool', name: 'Bash', status: 'start', detail: 'bun test' })
  piped.err.length = 0
  plain.tick()
  expect(piped.err.join('')).toBe('')

  // stdout a terminal and stderr a log: the line being written is held for stdout, and the log
  // still gets no live region drawn into it
  const split = harness({ tty: false, outTty: true })
  const view = turnRender('claude', split.deps)
  view.onEvent({ t: 'text', text: 'half a line' })
  expect(split.err.join('')).toBe('')

  // a terminal is never left looking hung: before the first event arrives the agent is working
  const tty = harness({ tty: true, hint: 'esc to interrupt' })
  const idle = turnRender('claude', tty.deps)
  tty.tick(3200)
  idle.tick()
  expect(tty.screen.text()).toMatch(/Working… \(3s · esc to interrupt\)$/)
})

test('the settled line replaces the animation, so one tool leaves exactly one line', () => {
  const h = harness({ tty: true })
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'tool', name: 'Read', status: 'start', detail: 'src/auth.ts' })
  h.tick(200)
  view.tick()
  view.tick()
  view.onEvent({ t: 'tool', name: 'Read', status: 'ok' })
  view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
  // what the person is left looking at: the settled line once, and nothing of the animation
  const screen = h.screen.lines()
  expect(screen.filter((l) => l.includes('Read'))).toEqual(['  ✓ Read  src/auth.ts  0.2s'])
  expect(h.screen.text()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Working/)
})

// A REPL that shows a turn's own cost and nothing else leaves the session total invisible until
// you stop and run `konvoy usage`. This is the same numbers, above the prompt, only when they
// have changed - the whole point is that it costs nothing to read and never scrolls on its own.
test('the status line carries the session total, in each unit that was actually reported', () => {
  expect(
    statusLine('token-refresh', [
      { turns: 8, inputTokens: 141200, outputTokens: 3100, costUsd: 1.2412, credits: 0 },
      { turns: 4, inputTokens: 7000, outputTokens: 900, costUsd: 0, credits: 0.19 },
    ], false),
  ).toBe('  token-refresh · 12 turns · 148.2k in / 4.0k out · $1.2412 · 0.190 cr')
})

test('a session with no turns yet has no status line to show', () => {
  expect(statusLine('s', [], false)).toBe('')
})

test('the status line shows only the units the agents reported', () => {
  const dollarsOnly = statusLine('s', [
    { turns: 1, inputTokens: 900, outputTokens: 20, costUsd: 0.02, credits: 0 },
  ], false)
  expect(dollarsOnly).toBe('  s · 1 turn · 900 in / 20 out · $0.0200')
  expect(dollarsOnly).not.toContain('cr')

  const creditsOnly = statusLine('s', [
    { turns: 2, inputTokens: 100, outputTokens: 5, costUsd: 0, credits: 0.5 },
  ], false)
  expect(creditsOnly).toContain('0.500 cr')
  expect(creditsOnly).not.toContain('$')
})

// The gap the mutation sweep found: nothing pinned the banner at the level that fixes the very
// problem the banner warns about, so flipping the condition back to "anything but yolo" passed.
test('the banner does not warn about refused tools at a level that approves them', () => {
  for (const permission of ['auto', 'yolo']) {
    const lines = sessionBanner(
      { version: '0.3.3', slug: 's', dir: '/d', agent: 'claude', harness: 'inherit', permission },
      false,
    ).join('\n')
    expect(lines, permission).not.toContain('needs approval')
  }
  for (const permission of ['safe', 'edit']) {
    const lines = sessionBanner(
      { version: '0.3.3', slug: 's', dir: '/d', agent: 'claude', harness: 'inherit', permission },
      false,
    ).join('\n')
    expect(lines, permission).toContain('needs approval')
  }
})

// The same turn as a person sees it: stdout and stderr on one terminal, the answer rendered a
// line at a time, the live region erased and redrawn around every permanent line.
test('a whole turn on a terminal leaves the tools, the answer and the footer, and no animation', () => {
  const h = harness({ tty: true, outTty: true, hint: 'esc to interrupt' })
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'thinking', text: '' })
  h.tick(400)
  view.tick()
  view.onEvent({ t: 'text', text: "I'll check the config." })
  view.onEvent({ t: 'tool', name: 'Read', status: 'start', detail: 'src/auth.ts' })
  h.tick(300)
  view.tick()
  view.onEvent({ t: 'tool', name: '', status: 'ok' })
  view.onEvent({ t: 'text', text: 'Switched the refresh ' })
  view.tick()
  view.onEvent({ t: 'text', text: 'to fire on 401.\nDone.' })
  h.tick(1000)
  view.finish({ inputTokens: 24400, outputTokens: 311, costUsd: 0.0621, credits: 0 })
  expect(h.screen.lines()).toEqual([
    "I'll check the config.",
    '  ✓ Read  src/auth.ts  0.3s',
    'Switched the refresh to fire on 401.',
    'Done.',
    '',
    '  claude · 1.7s · 24.4k in / 311 out · $0.0621',
  ])
  // the answer on stdout is still exactly the agent's words, line for line
  expect(view.streamed()).toBe("I'll check the config.Switched the refresh to fire on 401.\nDone.")
})

test('the line being written shows in the live region before its newline arrives', () => {
  const h = harness({ tty: true, outTty: true })
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'text', text: 'Half a sen' })
  expect(h.screen.lines()[0]).toBe('Half a sen')
  // and the status line sits under it, not beside it
  expect(h.screen.lines()[1]).toContain('Working…')
  view.onEvent({ t: 'text', text: 'tence.\n' })
  expect(h.screen.lines()[0]).toBe('Half a sentence.')
})

test('a line longer than the live region allows shows its tail, and arrives whole when complete', () => {
  const h = harness({ tty: true, outTty: true, columns: 20 })
  h.deps.rows = () => 10
  const view = turnRender('claude', h.deps)
  const long = 'word '.repeat(60)
  view.onEvent({ t: 'text', text: long })
  const live = h.screen.lines()
  // bounded: the live region never outgrows what it can move back up over
  expect(live.length).toBeLessThanOrEqual(5)
  expect(live[0]).toStartWith('…')
  view.onEvent({ t: 'text', text: '\n' })
  view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
  // committed whole, as one line of stdout
  expect(h.out.join('')).toContain(`${long}\n`)
})

test('on a terminal the answer is rendered as Markdown; to a pipe it stays the agent own bytes', () => {
  const md = '# Plan\n- **fix** the `retry_count`\n```ts\nconst a = 1\n```\n'
  const tty = harness({ tty: true, outTty: true, color: true })
  const view = turnRender('claude', tty.deps)
  view.onEvent({ t: 'text', text: md })
  view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
  const shown = tty.screen.lines()
  expect(shown.slice(0, 5)).toEqual(['Plan', '• fix the retry_count', '```ts', 'const a = 1', '```'])

  const piped = harness({ tty: false, outTty: false, color: true })
  const plain = turnRender('claude', piped.deps)
  plain.onEvent({ t: 'text', text: md })
  expect(piped.out.join('')).toBe(md)
})

test('a quota window near its edge is named after the footer, with when it resets', () => {
  const h = harness()
  const view = turnRender('claude', h.deps)
  view.onEvent({ t: 'limit', window: 'seven_day', utilization: 0.97, warning: true })
  view.onEvent({ t: 'limit', window: 'five_hour', utilization: 0.3, warning: false })
  view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
  const lines = h.err.join('').trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('  ! claude has used 97% of its weekly limit')
})

test('a reset time reads as a clock today and as a weekday further off', () => {
  const now = new Date(2026, 8, 24, 10, 0).getTime()
  const soon = limitNotice('claude', { t: 'limit', window: 'five_hour', utilization: 0.95, warning: true, resetsAt: new Date(2026, 8, 24, 13, 5).getTime() / 1000 }, now)
  expect(soon).toBe('claude has used 95% of its 5-hour limit · resets 13:05')
  const later = limitNotice('claude', { t: 'limit', window: 'seven_day', utilization: 0.9, warning: true, resetsAt: new Date(2026, 8, 28, 7, 0).getTime() / 1000 }, now)
  expect(later).toBe('claude has used 90% of its weekly limit · resets Mon 07:00')
})

test('durations and token counts stay short at every size', () => {
  expect(duration(3100)).toBe('3.1s')
  expect(duration(65_000)).toBe('1m 05s')
  expect(duration(3_725_000)).toBe('1h 02m')
  expect(tokens(999)).toBe('999')
  expect(tokens(24_400)).toBe('24.4k')
  expect(tokens(1_234_567)).toBe('1.2M')
  expect(tokens(999_960)).toBe('1.0M')
})

test('what the thinking is about is named while it runs, and never kept', () => {
  const h = harness({ tty: true })
  const view = turnRender('codex', h.deps)
  view.onEvent({ t: 'thinking', text: '**Inspecting the auth flow**\n\nThe refresh path reads the token' })
  expect(h.screen.text()).toContain('Thinking… Inspecting the auth flow')
  view.onEvent({ t: 'text', text: 'ok' })
  view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
  expect(h.screen.text()).not.toContain('Inspecting')
})

// Model output can carry what the model read. A file that holds an escape sequence and is echoed
// back would, streamed raw, clear the screen or write the clipboard through OSC 52.
test('an escape sequence in the streamed answer never reaches the terminal', () => {
  for (const outTty of [false, true]) {
    const h = harness({ tty: true, outTty })
    const view = turnRender('claude', h.deps)
    view.onEvent({ t: 'text', text: 'safe \x1b]52;c;cHduZWQ=\x07text\x1b[2J\n' })
    view.onEvent({ t: 'thinking', text: '**look\x1b[31m here**' })
    view.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0, credits: 0 })
    expect(h.out.join(''), `outTty ${outTty}`).toBe('safe text\n')
    expect(h.err.join('')).not.toContain('\x1b[31m')
    expect(view.streamed()).toBe('safe text\n')
  }
})
