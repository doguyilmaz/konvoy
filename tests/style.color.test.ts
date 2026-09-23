import { expect, test } from 'bun:test'
import { agentPaint, colorEnabled, palette } from '../src/style'
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
    expect(out, name).toContain('text')
    expect(out.startsWith('\x1b['), name).toBe(true)
    expect(out.endsWith('\x1b[0m'), name).toBe(true)
  }
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
})
