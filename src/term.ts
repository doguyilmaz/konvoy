// Terminal geometry: how many cells a string occupies, so a redraw can erase exactly what it drew.
// A redraw that counts UTF-16 code units instead of cells leaves the tail of an emoji or a CJK
// word behind, and one that counts escape bytes as cells wraps a line that never reached the edge.

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

// Wide ranges: CJK, Hangul, fullwidth forms, and the emoji blocks terminals draw two cells wide.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

function isWide(cp: number): boolean {
  let lo = 0
  let hi = WIDE.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = WIDE[mid]!
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

// combining marks, zero-width joiners and variation selectors draw nothing of their own
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp === 0x2060
  )
}

export function charWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (isZeroWidth(cp)) return 0
  return isWide(cp) ? 2 : 1
}

/** cells a string occupies on one line, escape sequences excluded */
export function stringWidth(text: string): number {
  let width = 0
  for (const char of stripAnsi(text)) width += charWidth(char)
  return width
}

/** the longest prefix of plain `text` that fits in `max` cells, with an ellipsis when it was cut */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (stringWidth(text) <= max) return text
  let out = ''
  let width = 0
  for (const char of text) {
    const w = charWidth(char)
    if (width + w > max - 1) break
    out += char
    width += w
  }
  return `${out}…`
}

/**
 * rows a plain line occupies once the terminal wraps it: a wide character that does not fit in
 * the last cell moves whole to the next row, which counting cells alone gets wrong by one
 */
export function wrappedRows(plain: string, columns: number): number {
  if (columns <= 0) return 1
  let rows = 1
  let col = 0
  for (const char of plain) {
    const w = charWidth(char)
    if (w === 0) continue
    if (col + w > columns) {
      rows++
      col = 0
    }
    col += w
  }
  return rows
}

/** how many terminal rows a line of this many cells takes at this width - never zero */
export function rowsFor(cells: number, columns: number): number {
  if (columns <= 0) return 1
  return Math.max(1, Math.ceil(cells / columns))
}

export const CLEAR_LINE = '\r\x1b[2K'
export const up = (n: number): string => (n > 0 ? `\x1b[${n}A` : '')

/** erase `rows` rows ending at the cursor's row, leaving the cursor at column 0 of the first */
export function eraseRows(rows: number): string {
  if (rows <= 0) return ''
  let out = CLEAR_LINE
  for (let i = 1; i < rows; i++) out += `\x1b[1A${CLEAR_LINE}`
  return out
}

export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'
