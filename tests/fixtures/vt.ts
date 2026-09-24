// A small terminal emulator for tests: enough of a VT100 to replay what konvoy writes and read
// back what a person would SEE once it settles. A live region is redrawn many times and erased at
// the end, so asserting on the bytes says little; asserting on the screen says whether a spinner
// was left behind, a line was doubled, or an answer landed on the same row as a tool line.
//
// Handles printable text (wide characters take two cells), CR, LF (with the ONLCR a tty applies
// to output), backspace, CUU/CUD/CUF/CUB, CHA, EL, ED, and ignores SGR, private modes and OSC.
import { charWidth } from '../../src/term'

export class Screen {
  rows: string[][] = [[]]
  row = 0
  col = 0
  private pendingWrap = false

  constructor(readonly columns = 80) {}

  private line(r: number): string[] {
    while (this.rows.length <= r) this.rows.push([])
    return this.rows[r]!
  }

  private put(ch: string, w: number): void {
    if (this.pendingWrap || this.col + w > this.columns) {
      this.row++
      this.col = 0
      this.pendingWrap = false
    }
    const line = this.line(this.row)
    while (line.length < this.col) line.push(' ')
    line[this.col] = ch
    if (w === 2) line[this.col + 1] = ''
    this.col += w
    if (this.col >= this.columns) {
      this.col = this.columns - 1
      this.pendingWrap = true
    }
  }

  write(data: string): this {
    for (let i = 0; i < data.length; ) {
      const ch = data[i]!
      if (ch === '\x1b') {
        const rest = data.slice(i)
        const csi = /^\x1b\[([?0-9;]*)([ -\/]*)([@-~])/.exec(rest)
        if (csi) {
          this.csi(csi[1]!, csi[3]!)
          i += csi[0].length
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest)
        if (osc) {
          i += osc[0].length
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') {
        this.col = 0
        this.pendingWrap = false
      } else if (ch === '\n') {
        this.row++
        this.col = 0
        this.pendingWrap = false
        this.line(this.row)
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1)
        this.pendingWrap = false
      } else if (ch === '\t') {
        this.col = Math.min(this.columns - 1, (Math.floor(this.col / 8) + 1) * 8)
      } else if (ch >= ' ') {
        const cp = data.codePointAt(i)!
        const char = String.fromCodePoint(cp)
        const w = charWidth(char)
        if (w > 0) this.put(char, w)
        i += char.length
        continue
      }
      i++
    }
    return this
  }

  private csi(params: string, final: string): void {
    const n = Number.parseInt(params.replace('?', ''), 10)
    const count = Number.isNaN(n) ? 1 : n
    if (params.startsWith('?')) return
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - count)
        this.pendingWrap = false
        break
      case 'B':
        this.row += count
        this.line(this.row)
        this.pendingWrap = false
        break
      case 'C':
        this.col = Math.min(this.columns - 1, this.col + count)
        break
      case 'D':
        this.col = Math.max(0, this.col - count)
        this.pendingWrap = false
        break
      case 'G':
        this.col = Math.max(0, Math.min(this.columns - 1, count - 1))
        this.pendingWrap = false
        break
      case 'K': {
        const line = this.line(this.row)
        const mode = Number.isNaN(n) ? 0 : n
        if (mode === 2) line.length = 0
        else if (mode === 0) line.length = Math.min(line.length, this.col)
        else for (let c = 0; c <= this.col && c < line.length; c++) line[c] = ' '
        break
      }
      case 'J': {
        const mode = Number.isNaN(n) ? 0 : n
        if (mode === 2 || mode === 3) {
          this.rows = [[]]
          this.row = 0
          this.col = 0
        } else if (mode === 0) {
          this.line(this.row).length = this.col
          this.rows.length = this.row + 1
        }
        break
      }
      case 'H':
        this.row = 0
        this.col = 0
        break
      default:
        break
    }
  }

  /** the visible text, trailing blanks trimmed, trailing empty rows dropped */
  text(): string {
    const lines = this.rows.map((r) => r.join('').trimEnd())
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()
    return lines.join('\n')
  }

  lines(): string[] {
    return this.text().split('\n')
  }
}
