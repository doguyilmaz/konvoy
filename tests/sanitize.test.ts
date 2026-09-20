import { expect, test } from 'bun:test'
import { oneLine, safeText, stripControlChars } from '../src/adapters/types'

// What an agent writes and what a CLI puts on stderr both reach the terminal through konvoy's
// own notices and output. Escape sequences there can erase the `· <tool>` lines konvoy just
// printed — its record of what the agent did — so nothing from either source is printed raw.
test('stripControlChars removes whole escape sequences, not just the ESC byte', () => {
  // dropping only ESC would leave "[31m" behind in a session id or a notice
  expect(stripControlChars('a\u001b[31mb\u001b]0;title\u0007c\u001bMd\u0000e')).toBe('abcde')
})

test('oneLine folds newlines, drops control bytes and escapes, and caps the length', () => {
  expect(oneLine('check\u001b[2K the retry\r\nplease')).toBe('check the retry please')
  expect(oneLine('  a  \n\n  b  ')).toBe('a b')
  const long = oneLine('x'.repeat(300))
  expect(long).toHaveLength(201)
  expect(long.endsWith('…')).toBe(true)
  expect(oneLine('y'.repeat(300), 50)).toHaveLength(51)
})

test('safeText keeps newlines and tabs, drops every other control byte including CR', () => {
  expect(safeText('ok\u001b[2J\u0007\n\tx\ry')).toBe('ok\n\txy')
})
