// The REPL's line editor: raw-mode input for a person at a terminal, drawn the way the agent CLIs
// draw theirs - the input between two rules, a footer under it, a popup of commands while a `/`
// word is being typed. Everything a key does is a pure function of the editor state (EditorCore),
// and everything drawn is a pure function of that state and a width (renderEditor), so both are
// tested without a terminal; terminalEditor only moves bytes between them and the tty.
import { charWidth, stringWidth, truncate } from './term'
import type { Paint } from './style'

// ---------------------------------------------------------------------------------------------
// keys

export type Key =
  | { name: 'text'; text: string }
  | { name: 'paste'; text: string }
  | {
      name:
        | 'enter'
        | 'newline'
        | 'backspace'
        | 'delete'
        | 'left'
        | 'right'
        | 'up'
        | 'down'
        | 'home'
        | 'end'
        | 'tab'
        | 'backtab'
        | 'escape'
        | 'wordLeft'
        | 'wordRight'
        | 'killWordLeft'
        | 'killWordRight'
        | 'pageUp'
        | 'pageDown'
    }
  | { name: 'ctrl'; key: string }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const CSI_TILDE: Record<string, Key['name']> = {
  '1': 'home',
  '7': 'home',
  '4': 'end',
  '8': 'end',
  '3': 'delete',
  '5': 'pageUp',
  '6': 'pageDown',
}

// What a terminal sends in raw mode, decoded into keys. A chunk is whatever one read returned, so
// an escape sequence or a paste can arrive split; what could still be the head of one is held.
export function keyDecoder(): { push: (chunk: string) => Key[] } {
  let pending = ''
  let paste: string | null = null

  return {
    push(chunk) {
      pending += chunk
      const keys: Key[] = []
      let text = ''
      const flushText = (): void => {
        if (text !== '') keys.push({ name: 'text', text })
        text = ''
      }
      const emit = (key: Key): void => {
        flushText()
        keys.push(key)
      }

      while (pending.length > 0) {
        if (paste !== null) {
          const end = pending.indexOf(PASTE_END)
          if (end === -1) {
            // hold back only the tail that could still be the head of a split end marker
            let keep = Math.min(PASTE_END.length - 1, pending.length)
            while (keep > 0 && !PASTE_END.startsWith(pending.slice(pending.length - keep))) keep--
            paste += pending.slice(0, pending.length - keep)
            pending = pending.slice(pending.length - keep)
            break
          }
          emit({ name: 'paste', text: (paste + pending.slice(0, end)).replace(/\r\n?/g, '\n') })
          paste = null
          pending = pending.slice(end + PASTE_END.length)
          continue
        }

        const ch = pending[0]!
        if (ch === '\x1b') {
          if (pending.startsWith(PASTE_START)) {
            flushText()
            paste = ''
            pending = pending.slice(PASTE_START.length)
            continue
          }
          if (pending.length === 1) {
            // a lone ESC at the end of a read is the Escape key: a sequence arrives in one read
            emit({ name: 'escape' })
            pending = ''
            break
          }
          const next = pending[1]!
          if (next === '[' || next === 'O') {
            const m = next === '[' ? /^\x1b\[([0-9;?<>]*)([ -\/]*)([@-~])/.exec(pending) : /^\x1bO([A-Za-z])/.exec(pending)
            if (!m) {
              // incomplete: wait for the rest, unless it can never complete
              if (/^\x1b[\[O][0-9;?<>]*$/.test(pending) && pending.length < 16) break
              emit({ name: 'escape' })
              pending = pending.slice(1)
              continue
            }
            pending = pending.slice(m[0].length)
            const key = next === '[' ? csi(m[1]!, m[3]!) : ss3(m[1]!)
            if (key) emit(key)
            continue
          }
          // ESC then a character: Alt/Option held
          pending = pending.slice(2)
          if (next === 'b' || next === 'B') emit({ name: 'wordLeft' })
          else if (next === 'f' || next === 'F') emit({ name: 'wordRight' })
          else if (next === 'd') emit({ name: 'killWordRight' })
          else if (next === '\x7f' || next === '\b') emit({ name: 'killWordLeft' })
          else if (next === '\r' || next === '\n') emit({ name: 'newline' })
          else if (next === '\x1b') {
            emit({ name: 'escape' })
            pending = `\x1b${pending}`
          }
          continue
        }

        pending = pending.slice(1)
        if (ch === '\r') emit({ name: 'enter' })
        else if (ch === '\n') emit({ name: 'newline' })
        else if (ch === '\x7f' || ch === '\b') emit({ name: 'backspace' })
        else if (ch === '\t') emit({ name: 'tab' })
        else if (ch < ' ') emit({ name: 'ctrl', key: String.fromCharCode(ch.charCodeAt(0) + 96) })
        else text += ch
      }
      flushText()
      return keys
    },
  }
}

function csi(params: string, final: string): Key | null {
  const mod = params.split(';')[1]
  switch (final) {
    case 'A':
      return { name: 'up' }
    case 'B':
      return { name: 'down' }
    case 'C':
      return mod === '5' || mod === '3' ? { name: 'wordRight' } : { name: 'right' }
    case 'D':
      return mod === '5' || mod === '3' ? { name: 'wordLeft' } : { name: 'left' }
    case 'H':
      return { name: 'home' }
    case 'F':
      return { name: 'end' }
    case 'Z':
      return { name: 'backtab' }
    case 'u':
      // the kitty keyboard protocol and xterm's modifyOtherKeys: Shift+Enter is a newline
      if (params === '13;2') return { name: 'newline' }
      if (params === '13') return { name: 'enter' }
      return null
    case '~': {
      if (params === '27;2;13') return { name: 'newline' }
      const name = CSI_TILDE[params.split(';')[0] ?? '']
      return name ? ({ name } as Key) : null
    }
    default:
      return null
  }
}

function ss3(final: string): Key | null {
  const map: Record<string, Key['name']> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }
  const name = map[final]
  return name ? ({ name } as Key) : null
}

// ---------------------------------------------------------------------------------------------
// completion

export interface MenuItem {
  /** what the popup shows in its first column */
  label: string
  /** what replaces the word being completed */
  insert: string
  detail?: string
  /** accepting it with Enter runs the line at once: a command that takes no argument */
  run?: boolean
}

export interface Completion {
  /** where in the buffer the word being completed starts */
  start: number
  items: MenuItem[]
}

export type Completer = (buffer: string, cursor: number) => Completion | null

// ---------------------------------------------------------------------------------------------
// state

export type Action =
  | { t: 'none' }
  | { t: 'redraw' }
  | { t: 'submit'; text: string; echo: string }
  | { t: 'exit' }
  | { t: 'clearScreen' }
  | { t: 'cycleAgent' }

// A paste of a whole file into the prompt is one decision, not a screen of text to scroll past:
// past this size it is held under a placeholder, which the submitted line expands again.
const PASTE_LINES = 4
const PASTE_CHARS = 600
const PLACEHOLDER = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)

export class EditorCore {
  buffer = ''
  cursor = 0
  /** the entry being shown from history, -1 for the line being written */
  private historyIndex = -1
  private draft = ''
  private pastes = new Map<number, string>()
  private pasteCount = 0
  /** the popup's selection, and the buffer it was computed for */
  selected = 0
  menuDismissed = false
  /** Ctrl-R: the query and which match of it is shown */
  search: { query: string; skip: number } | null = null
  /** set by a first Ctrl-C on an empty line, until a second one or any other key */
  exitArmed = false
  /** whether the shortcut panel is open */
  help = false
  private lastEscape = 0

  constructor(
    public history: string[] = [],
    private complete: Completer = () => null,
    private now: () => number = () => Date.now(),
  ) {}

  /** the popup as the current buffer has it, or null */
  menu(): Completion | null {
    if (this.menuDismissed || this.search) return null
    const c = this.complete(this.buffer, this.cursor)
    if (!c || c.items.length === 0) return null
    // a word already typed out in full offers nothing more to choose
    if (c.items.length === 1 && this.buffer.slice(c.start, this.cursor) === c.items[0]!.insert) return null
    if (this.selected >= c.items.length) this.selected = 0
    return c
  }

  /** the history entry Ctrl-R's query currently lands on */
  searchMatch(): string | null {
    if (!this.search) return null
    const q = this.search.query.toLowerCase()
    let skip = this.search.skip
    for (const entry of this.history) {
      if (q !== '' && !entry.toLowerCase().includes(q)) continue
      if (skip-- > 0) continue
      return entry
    }
    return null
  }

  setBuffer(text: string, cursor = text.length): void {
    this.buffer = text
    this.cursor = cursor
    this.selected = 0
    this.menuDismissed = false
  }

  insert(text: string): void {
    this.setBuffer(this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor), this.cursor + text.length)
    this.historyIndex = -1
  }

  private paste(text: string): void {
    const lines = text.split('\n').length
    if (lines > PASTE_LINES || text.length > PASTE_CHARS) {
      const n = ++this.pasteCount
      this.pastes.set(n, text)
      this.insert(lines > 1 ? `[Pasted text #${n} +${lines} lines]` : `[Pasted text #${n}]`)
      return
    }
    this.insert(text)
  }

  /** the line as it is sent: every placeholder replaced by what was pasted */
  expanded(): string {
    return this.buffer.replace(PLACEHOLDER, (whole, n: string) => this.pastes.get(Number(n)) ?? whole)
  }

  private prev(i: number): number {
    if (i <= 0) return 0
    const code = this.buffer.charCodeAt(i - 1)
    return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? i - 2 : i - 1
  }

  private next(i: number): number {
    if (i >= this.buffer.length) return this.buffer.length
    const code = this.buffer.charCodeAt(i)
    return code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1
  }

  private wordLeft(i: number): number {
    let j = i
    while (j > 0 && !isWordChar(this.buffer[j - 1])) j = this.prev(j)
    while (j > 0 && isWordChar(this.buffer[j - 1])) j = this.prev(j)
    return j
  }

  private wordRight(i: number): number {
    let j = i
    while (j < this.buffer.length && !isWordChar(this.buffer[j])) j = this.next(j)
    while (j < this.buffer.length && isWordChar(this.buffer[j])) j = this.next(j)
    return j
  }

  private lineStart(i: number): number {
    return this.buffer.lastIndexOf('\n', i - 1) + 1
  }

  private lineEnd(i: number): number {
    const at = this.buffer.indexOf('\n', i)
    return at === -1 ? this.buffer.length : at
  }

  private deleteRange(from: number, to: number): void {
    if (from === to) return
    this.setBuffer(this.buffer.slice(0, from) + this.buffer.slice(to), from)
  }

  private moveVertical(dir: -1 | 1): boolean {
    const start = this.lineStart(this.cursor)
    const column = this.cursor - start
    if (dir === -1) {
      if (start === 0) return false
      const prevStart = this.lineStart(start - 1)
      this.cursor = Math.min(prevStart + column, start - 1)
      return true
    }
    const end = this.lineEnd(this.cursor)
    if (end === this.buffer.length) return false
    const nextStart = end + 1
    this.cursor = Math.min(nextStart + column, this.lineEnd(nextStart))
    return true
  }

  private recall(dir: -1 | 1): void {
    const target = this.historyIndex + (dir === -1 ? 1 : -1)
    if (target < -1 || target >= this.history.length) return
    if (this.historyIndex === -1) this.draft = this.buffer
    this.historyIndex = target
    const text = target === -1 ? this.draft : this.history[target]!
    this.setBuffer(text)
    this.menuDismissed = true
  }

  private submit(): Action {
    const text = this.expanded()
    const echo = this.buffer
    this.historyIndex = -1
    this.pastes.clear()
    this.setBuffer('')
    return { t: 'submit', text, echo }
  }

  private accept(item: MenuItem, start: number): void {
    const tail = this.buffer.slice(this.cursor)
    const spaced = item.run || tail.startsWith(' ') ? item.insert : `${item.insert} `
    this.setBuffer(this.buffer.slice(0, start) + spaced + tail, start + spaced.length)
  }

  handle(key: Key): Action {
    const armed = this.exitArmed
    this.exitArmed = false
    if (this.help && key.name !== 'ctrl') this.help = false

    if (this.search) return this.handleSearch(key)

    const menu = this.menu()
    switch (key.name) {
      case 'text': {
        // `?` on an empty line opens the shortcuts, the convention every agent CLI shares
        if (key.text === '?' && this.buffer === '') {
          this.help = true
          return { t: 'redraw' }
        }
        this.insert(key.text)
        return { t: 'redraw' }
      }
      case 'paste':
        this.paste(key.text)
        return { t: 'redraw' }
      case 'enter': {
        if (menu) {
          const item = menu.items[this.selected]!
          const typed = this.buffer.slice(menu.start, this.cursor)
          if (typed !== item.insert || !item.run) {
            this.accept(item, menu.start)
            if (!item.run) return { t: 'redraw' }
          }
          return this.submit()
        }
        // a trailing backslash is the portable newline: every terminal can type it
        if (this.buffer[this.cursor - 1] === '\\') {
          this.setBuffer(`${this.buffer.slice(0, this.cursor - 1)}\n${this.buffer.slice(this.cursor)}`, this.cursor)
          return { t: 'redraw' }
        }
        return this.submit()
      }
      case 'newline':
        this.insert('\n')
        return { t: 'redraw' }
      case 'tab': {
        if (menu) {
          this.accept(menu.items[this.selected]!, menu.start)
          return { t: 'redraw' }
        }
        return { t: 'none' }
      }
      case 'backtab':
        return { t: 'cycleAgent' }
      case 'backspace': {
        if (this.cursor === 0) return { t: 'none' }
        // a placeholder goes as one piece: half of one would expand to nothing
        const before = this.buffer.slice(0, this.cursor)
        const placeholder = /\[Pasted text #\d+(?: \+\d+ lines)?\]$/.exec(before)
        this.deleteRange(placeholder ? this.cursor - placeholder[0].length : this.prev(this.cursor), this.cursor)
        return { t: 'redraw' }
      }
      case 'delete':
        this.deleteRange(this.cursor, this.next(this.cursor))
        return { t: 'redraw' }
      case 'left':
        this.cursor = this.prev(this.cursor)
        return { t: 'redraw' }
      case 'right':
        if (this.cursor === this.buffer.length && menu) {
          this.accept(menu.items[this.selected]!, menu.start)
          return { t: 'redraw' }
        }
        this.cursor = this.next(this.cursor)
        return { t: 'redraw' }
      case 'wordLeft':
        this.cursor = this.wordLeft(this.cursor)
        return { t: 'redraw' }
      case 'wordRight':
        this.cursor = this.wordRight(this.cursor)
        return { t: 'redraw' }
      case 'killWordLeft':
        this.deleteRange(this.wordLeft(this.cursor), this.cursor)
        return { t: 'redraw' }
      case 'killWordRight':
        this.deleteRange(this.cursor, this.wordRight(this.cursor))
        return { t: 'redraw' }
      case 'home':
        this.cursor = this.lineStart(this.cursor)
        return { t: 'redraw' }
      case 'end':
        this.cursor = this.lineEnd(this.cursor)
        return { t: 'redraw' }
      case 'up':
        if (menu) {
          this.selected = (this.selected - 1 + menu.items.length) % menu.items.length
          return { t: 'redraw' }
        }
        if (!this.moveVertical(-1)) this.recall(-1)
        return { t: 'redraw' }
      case 'down':
        if (menu) {
          this.selected = (this.selected + 1) % menu.items.length
          return { t: 'redraw' }
        }
        if (!this.moveVertical(1)) this.recall(1)
        return { t: 'redraw' }
      case 'pageUp':
      case 'pageDown':
        return { t: 'none' }
      case 'escape': {
        if (menu) {
          this.menuDismissed = true
          return { t: 'redraw' }
        }
        // Esc twice clears the line, the way the agent CLIs do
        const now = this.now()
        if (this.buffer !== '' && now - this.lastEscape < 600) {
          this.setBuffer('')
          this.lastEscape = 0
          return { t: 'redraw' }
        }
        this.lastEscape = now
        return { t: 'none' }
      }
      case 'ctrl':
        return this.handleCtrl(key.key, armed, menu)
    }
  }

  private handleCtrl(k: string, armed: boolean, menu: Completion | null): Action {
    switch (k) {
      case 'c':
        // clear what is typed; on an empty line, arm the exit - a second Ctrl-C leaves
        if (this.buffer !== '') {
          this.setBuffer('')
          this.historyIndex = -1
          return { t: 'redraw' }
        }
        if (armed) return { t: 'exit' }
        this.exitArmed = true
        return { t: 'redraw' }
      case 'd':
        if (this.buffer === '') return { t: 'exit' }
        this.deleteRange(this.cursor, this.next(this.cursor))
        return { t: 'redraw' }
      case 'a':
        this.cursor = this.lineStart(this.cursor)
        return { t: 'redraw' }
      case 'e':
        this.cursor = this.lineEnd(this.cursor)
        return { t: 'redraw' }
      case 'b':
        this.cursor = this.prev(this.cursor)
        return { t: 'redraw' }
      case 'f':
        this.cursor = this.next(this.cursor)
        return { t: 'redraw' }
      case 'k':
        this.deleteRange(this.cursor, this.lineEnd(this.cursor) === this.cursor ? this.next(this.cursor) : this.lineEnd(this.cursor))
        return { t: 'redraw' }
      case 'u':
        this.deleteRange(this.lineStart(this.cursor), this.cursor)
        return { t: 'redraw' }
      case 'w':
        this.deleteRange(this.wordLeft(this.cursor), this.cursor)
        return { t: 'redraw' }
      case 'l':
        return { t: 'clearScreen' }
      case 'p':
        return this.handle({ name: 'up' })
      case 'n':
        return this.handle({ name: 'down' })
      case 'r':
        this.search = { query: '', skip: 0 }
        return { t: 'redraw' }
      case 'g':
        if (menu) this.menuDismissed = true
        return { t: 'redraw' }
      default:
        return { t: 'none' }
    }
  }

  private handleSearch(key: Key): Action {
    const search = this.search!
    const take = (): void => {
      const match = this.searchMatch()
      this.search = null
      if (match !== null) this.setBuffer(match)
      this.menuDismissed = true
    }
    switch (key.name) {
      case 'text':
        search.query += key.text
        search.skip = 0
        return { t: 'redraw' }
      case 'paste':
        search.query += key.text.replace(/\n/g, ' ')
        return { t: 'redraw' }
      case 'backspace':
        search.query = search.query.slice(0, -1)
        search.skip = 0
        return { t: 'redraw' }
      case 'enter':
      case 'tab':
      case 'right':
      case 'end':
        take()
        return { t: 'redraw' }
      case 'escape':
        this.search = null
        return { t: 'redraw' }
      case 'ctrl':
        if (key.key === 'r') {
          if (this.searchMatch() !== null) search.skip++
          if (this.searchMatch() === null) search.skip--
          return { t: 'redraw' }
        }
        if (key.key === 'g' || key.key === 'c') {
          this.search = null
          return { t: 'redraw' }
        }
        take()
        return this.handle(key)
      default:
        take()
        return this.handle(key)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// drawing

export interface PromptSpec {
  /** the painted prompt, `claude › ` */
  prompt: string
  /** shown dim in an empty line */
  placeholder: string
  /** the painted footer under the lower rule: left part and right part */
  footer: [string, string]
  /** how the popup and other chrome is painted */
  paint: { dim: Paint; accent: Paint; inverse: Paint; bold: Paint; yellow: Paint }
  /** the shortcut panel `?` opens */
  shortcuts: readonly [string, string][]
  /** paints a word of the line: a command, an agent mention */
  highlight?: (word: string, first: boolean) => Paint | null
}

export interface Drawn {
  lines: string[]
  /** where the cursor sits, as a row within `lines` and a cell column */
  row: number
  col: number
}

const MENU_ROWS = 6

// Lay the buffer out in rows of at most `columns` cells, the prompt ahead of the first row and
// its width of indent ahead of every later logical line, and find the cursor's cell.
function layout(
  buffer: string,
  cursor: number,
  promptWidth: number,
  columns: number,
  paintWord: (start: number) => Paint | null,
): { rows: { cells: { ch: string; paint: Paint | null }[]; lead: boolean }[]; row: number; col: number } {
  const rows: { cells: { ch: string; paint: Paint | null }[]; lead: boolean }[] = [{ cells: [], lead: true }]
  let width = promptWidth
  let row = 0
  let col = promptWidth
  let found = false
  let i = 0
  const place = (): void => {
    if (found) return
    if (i === cursor) {
      found = true
      // a cursor after a full row sits at the start of the next one
      if (width >= columns) {
        rows.push({ cells: [], lead: false })
        width = 0
      }
      row = rows.length - 1
      col = width
    }
  }
  let painting: Paint | null = null
  for (const ch of buffer) {
    place()
    if (i === 0 || buffer[i - 1] === ' ' || buffer[i - 1] === '\n') painting = paintWord(i)
    if (ch === ' ' || ch === '\n') painting = null
    if (ch === '\n') {
      rows.push({ cells: [], lead: true })
      width = promptWidth
      i += ch.length
      continue
    }
    const w = Math.max(1, charWidth(ch))
    if (width + w > columns) {
      rows.push({ cells: [], lead: false })
      width = 0
    }
    // a tab would jump to the terminal's next tab stop, a width the layout cannot know: it is drawn
    // as the one cell it is counted as, and sent as the tab it is
    rows.at(-1)!.cells.push({ ch: ch === '\t' ? ' ' : ch, paint: painting })
    width += w
    i += ch.length
  }
  place()
  if (!found) {
    row = rows.length - 1
    col = width
  }
  return { rows, row, col }
}

function paintRun(cells: { ch: string; paint: Paint | null }[]): string {
  let out = ''
  let run = ''
  let current: Paint | null = null
  for (const cell of cells) {
    if (cell.paint !== current) {
      out += current ? current(run) : run
      run = ''
      current = cell.paint
    }
    run += cell.ch
  }
  return out + (current ? current(run) : run)
}

export function renderEditor(core: EditorCore, spec: PromptSpec, columns: number, maxRows = 12): Drawn {
  const cols = Math.max(20, columns)
  const { dim, accent, inverse, bold, yellow } = spec.paint
  const promptWidth = stringWidth(spec.prompt)
  const rule = dim('─'.repeat(cols))
  const lines: string[] = [rule]

  let cursorRow: number
  let cursorCol: number
  const match = core.searchMatch()
  if (core.search) {
    const shown = match ?? ''
    const label = `(reverse-i-search) '${core.search.query}': `
    const text = truncate(shown.replace(/\n/g, ' ⏎ '), Math.max(1, cols - stringWidth(label) - 1))
    lines.push(`${dim(label)}${text}`)
    cursorRow = 1
    cursorCol = Math.min(cols - 1, stringWidth(label) - 3)
  } else {
    const word = (start: number): Paint | null => {
      if (!spec.highlight) return null
      const end = core.buffer.slice(start).search(/[\s]/)
      return spec.highlight(core.buffer.slice(start, end === -1 ? undefined : start + end), start === 0)
    }
    const laid = layout(core.buffer, core.cursor, promptWidth, cols, word)
    // a buffer taller than the region shows the rows around the cursor
    const inputRows = Math.max(1, maxRows)
    const first = Math.min(Math.max(0, laid.row - inputRows + 1), Math.max(0, laid.rows.length - inputRows))
    const visible = laid.rows.slice(first, first + inputRows)
    visible.forEach((r, i) => {
      const index = first + i
      const lead = index === 0 ? spec.prompt : r.lead ? ' '.repeat(promptWidth) : ''
      const body = core.buffer === '' && index === 0 ? dim(truncate(spec.placeholder, Math.max(1, cols - promptWidth - 1))) : paintRun(r.cells)
      lines.push(`${lead}${body}`)
    })
    cursorRow = 1 + laid.row - first
    cursorCol = laid.col
  }
  lines.push(rule)

  const menu = core.menu()
  if (core.help) {
    const width = Math.max(...spec.shortcuts.map(([k]) => stringWidth(k)))
    for (const [k, v] of spec.shortcuts) {
      const key = k + ' '.repeat(Math.max(0, width - stringWidth(k)))
      lines.push(`  ${bold(key)}  ${dim(truncate(v, Math.max(1, cols - width - 5)))}`)
    }
  } else if (menu) {
    const start = Math.min(Math.max(0, core.selected - MENU_ROWS + 1), Math.max(0, menu.items.length - MENU_ROWS))
    const shown = menu.items.slice(start, start + MENU_ROWS)
    const width = Math.min(28, Math.max(...shown.map((m) => stringWidth(m.label))))
    shown.forEach((item, i) => {
      const selected = start + i === core.selected
      const cut = truncate(item.label, width)
      const label = cut + ' '.repeat(Math.max(0, width - stringWidth(cut)))
      const detail = item.detail ? truncate(item.detail, Math.max(1, cols - width - 7)) : ''
      lines.push(selected ? `${accent('❯')} ${inverse(` ${label} `)} ${detail}` : `  ${` ${label} `} ${dim(detail)}`)
    })
    if (menu.items.length > MENU_ROWS) lines.push(dim(`  ${core.selected + 1}/${menu.items.length}`))
  } else if (core.exitArmed) {
    lines.push(yellow('  press Ctrl-C again to exit'))
  } else {
    const [left, right] = spec.footer
    const room = cols - 1 - stringWidth(left)
    const r = stringWidth(right) <= room - 2 ? right : ''
    lines.push(`${left}${' '.repeat(Math.max(1, room - stringWidth(r)))}${r}`.trimEnd())
  }
  return { lines, row: cursorRow, col: cursorCol }
}

// ---------------------------------------------------------------------------------------------
// the terminal

/** the part of process.stdin raw input needs */
export interface RawInput {
  on: (event: 'data', handler: (chunk: Uint8Array) => void) => void
  pause: () => void
  resume: () => void
  setRawMode: (on: boolean) => void
  isTTY?: boolean | undefined
}

export interface EditorIo {
  /** draw the prompt, edit a line, and return it - or null when the person leaves */
  read: (spec: () => PromptSpec) => Promise<string | null>
  /** run a turn with the keyboard watched: Esc or Ctrl-C aborts it, anything else waits its turn */
  busy: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T>
  /** hand the terminal over - an attached TUI, a shell - in the mode it was found in */
  suspend: <T>(fn: () => Promise<T>) => Promise<T>
  clearScreen: () => void
  close: () => void
  /** Shift-Tab: the REPL moves to the next agent, and the prompt is redrawn for it */
  onCycle?: () => void
}

export interface EditorDeps {
  input: RawInput
  write: (text: string) => void
  columns: () => number
  rows: () => number
  history: History
  completer: Completer
  /** a terminal resize: the prompt is redrawn at the new width */
  onResize?: (redraw: () => void) => () => void
  now?: () => number
}

interface History {
  entries: () => string[]
  add: (text: string) => void
}

const SYNC_ON = '\x1b[?2026h'
const SYNC_OFF = '\x1b[?2026l'
const BRACKETED_ON = '\x1b[?2004h'
const BRACKETED_OFF = '\x1b[?2004l'
const upRows = (n: number): string => (n > 0 ? `\x1b[${n}A` : '')

export function terminalEditor(deps: EditorDeps): EditorIo {
  const { input, write } = deps
  const decoder = keyDecoder()
  const text = new TextDecoder()
  // keys decoded but not yet taken: what was typed after a submit belongs to the next prompt
  const queue: Key[] = []
  let consumer: (() => void) | null = null
  // raw bytes that arrived during a turn, replayed into the next prompt
  let typeahead = ''
  let onBusyInput: ((chunk: string) => void) | null = null
  let raw = false

  const setRaw = (on: boolean): void => {
    if (raw === on) return
    raw = on
    try {
      input.setRawMode(on)
    } catch {
      // a stream that stopped being a terminal
    }
  }

  input.on('data', (chunk) => {
    const s = text.decode(chunk, { stream: true })
    if (onBusyInput) return onBusyInput(s)
    if (!consumer) {
      typeahead += s
      return
    }
    queue.push(...decoder.push(s))
    consumer()
  })
  write(BRACKETED_ON)

  const self: EditorIo = {
    read(spec) {
      return new Promise((resolve) => {
        const core = new EditorCore(deps.history.entries(), deps.completer, deps.now)
        let drawn = false
        let drawnRow = 0
        const draw = (): void => {
          const maxRows = Math.max(3, deps.rows() - 10)
          const d = renderEditor(core, spec(), deps.columns(), maxRows)
          let out = SYNC_ON
          if (drawn) out += `\r${upRows(drawnRow)}\x1b[J`
          out += d.lines.join('\n')
          out += `${upRows(d.lines.length - 1 - d.row)}\r${d.col > 0 ? `\x1b[${d.col}C` : ''}${SYNC_OFF}`
          write(out)
          drawn = true
          drawnRow = d.row
        }
        const erase = (): void => {
          if (drawn) write(`\r${upRows(drawnRow)}\x1b[J`)
          drawn = false
        }
        const stopResize = deps.onResize?.(draw)
        const done = (value: string | null): void => {
          consumer = null
          stopResize?.()
          setRaw(false)
          input.pause()
          resolve(value)
        }
        const take = (): void => {
          while (queue.length > 0) {
            const action = core.handle(queue.shift()!)
            switch (action.t) {
              case 'submit': {
                erase()
                const s = spec()
                const indent = ' '.repeat(stringWidth(s.prompt))
                write(`${s.prompt}${action.echo.split('\n').join(`\n${indent}`)}\n`)
                // the whole line: a placeholder recalled later would expand to nothing
                deps.history.add(action.text)
                return done(action.text)
              }
              case 'exit':
                erase()
                return done(null)
              case 'clearScreen':
                write('\x1b[H\x1b[2J')
                drawn = false
                break
              case 'cycleAgent':
                self.onCycle?.()
                break
              default:
                break
            }
          }
          draw()
        }
        consumer = take
        setRaw(true)
        input.resume()
        if (typeahead !== '') {
          const pending = typeahead
          typeahead = ''
          queue.push(...decoder.push(pending))
        }
        if (queue.length > 0) take()
        else draw()
      })
    },

    async busy(fn) {
      const controller = new AbortController()
      onBusyInput = (chunk) => {
        // a lone ESC is the key; Ctrl-C arrives as its byte because the terminal is raw
        if (chunk === '\x1b' || chunk.includes('\x03')) {
          controller.abort()
          typeahead += chunk.replace(/\x03/g, '').replace(/^\x1b$/, '')
          return
        }
        typeahead += chunk
      }
      setRaw(true)
      input.resume()
      try {
        return await fn(controller.signal)
      } finally {
        onBusyInput = null
        setRaw(false)
        input.pause()
      }
    },

    async suspend(fn) {
      setRaw(false)
      input.pause()
      write(BRACKETED_OFF)
      try {
        return await fn()
      } finally {
        write(BRACKETED_ON)
      }
    },

    clearScreen() {
      write('\x1b[H\x1b[2J')
    },

    close() {
      setRaw(false)
      input.pause()
      write(BRACKETED_OFF)
    },
  }
  return self
}
