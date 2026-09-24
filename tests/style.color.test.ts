import { expect, test } from 'bun:test'
import { agentPaint, colorEnabled, colorLevel, hex, palette } from '../src/style'
import { agentIds } from '../src/config/schema'

// konvoy printed no colour at all, which is the difference between a wall of text and something
// a reader can skim. Colour is a terminal capability, not a preference, so the decision is made
// once from the environment and a non-tty writes plain text: a piped `konvoy usage` stays
// machine-readable, and NO_COLOR is honoured because that is the standard users expect.
test('colour follows the terminal, and NO_COLOR wins over it', () => {
  expect(colorEnabled({}, true)).toBe(true)
  expect(colorEnabled({}, false)).toBe(false)
  expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false)
  expect(colorEnabled({ NO_COLOR: '' }, true)).toBe(true)
  expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false)
  // a pipe into something that does render colour, which is how a demo or a CI log gets it
  expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true)
  expect(colorEnabled({ FORCE_COLOR: '0' }, true)).toBe(true)
  expect(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false)
})

test('a plain palette is the identity, so one render path serves both', () => {
  const plain = palette(false)
  for (const paint of Object.values(plain)) expect(paint('text')).toBe('text')
})

test('a colour palette wraps and closes every sequence it opens', () => {
  const p = palette(true)
  for (const [name, paint] of Object.entries(p)) {
    const out = paint('text')
    expect(out, name).toMatch(/^\x1b\[\d+mtext\x1b\[\d+m$/)
    // its own close, never a blanket reset that would end whatever it sits inside
    expect(out.endsWith('\x1b[0m'), name).toBe(false)
  }
})

// The defect this replaced: every paint closed with \x1b[0m, so a green ✓ inside a dim tool line
// ended the dim with it and the rest of the line printed bright.
test('a span painted inside another leaves the outer style standing after it closes', () => {
  const p = palette(true)
  const line = p.dim(`  ${p.green('✓')} Read`)
  // green closes with 39 (foreground only), so the dim around it is untouched
  expect(line).toBe('\x1b[2m  \x1b[32m✓\x1b[39m Read\x1b[22m')
  // bold and dim share a close code, so an inner one re-opens the outer after itself
  expect(p.dim(`a${p.bold('b')}c`)).toBe('\x1b[2ma\x1b[1mb\x1b[22m\x1b[2mc\x1b[22m')
})

test('the colour depth is read from the variables terminals set for it', () => {
  expect(colorLevel({}, false)).toBe(0)
  expect(colorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(0)
  expect(colorLevel({ TERM: 'xterm' }, true)).toBe(1)
  expect(colorLevel({ TERM: 'xterm-256color' }, true)).toBe(2)
  expect(colorLevel({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, true)).toBe(3)
  expect(colorLevel({ TERM_PROGRAM: 'vscode' }, true)).toBe(3)
  expect(colorLevel({ FORCE_COLOR: '3' }, false)).toBe(3)
  expect(colorLevel({ FORCE_COLOR: '2', COLORTERM: 'truecolor' }, true)).toBe(2)
})

test('a brand colour degrades to the nearest the terminal can show', () => {
  expect(hex('#D77757', 3, 'cyan')('x')).toBe('\x1b[38;2;215;119;87mx\x1b[39m')
  expect(hex('#D77757', 2, 'cyan')('x')).toMatch(/^\x1b\[38;5;\d+mx\x1b\[39m$/)
  expect(hex('#D77757', 1, 'cyan')('x')).toBe('\x1b[36mx\x1b[39m')
  expect(hex('#D77757', 0, 'cyan')('x')).toBe('x')
  // greys land on the grey ramp, not the colour cube
  expect(hex('#808080', 2, 'gray')('x')).toBe('\x1b[38;5;244mx\x1b[39m')
})

// Derived from the roster rather than a literal list: an agent added without a colour of its own
// falls back to `bold` and becomes indistinguishable from another in a transcript, which is the
// failure this asserts against. It fails the moment a fifth agent is added without a colour.
test('each agent keeps one colour, so a roster or a transcript is readable at a glance', () => {
  const on = agentPaint(true)
  const seen = new Set<string>()
  for (const agent of agentIds) {
    const out = on(agent)(agent)
    expect(out).toContain(agent)
    seen.add(out.slice(0, out.indexOf('m') + 1))
  }
  expect(seen.size, 'every agent needs its own colour').toBe(agentIds.length)
  expect(agentPaint(false)('claude')('claude')).toBe('claude')
  // and the same holds at every depth the brand colours are drawn in
  for (const level of [2, 3] as const) {
    const at = new Set(agentIds.map((a) => agentPaint(level)(a)(a).split('m')[0]))
    expect(at.size, `level ${level}`).toBe(agentIds.length)
  }
})
