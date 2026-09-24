import { expect, test } from 'bun:test'
import { EditorCore, keyDecoder, renderEditor, terminalEditor, type Key, type PromptSpec, type RawInput } from '../src/editor'
import { memoryHistory } from '../src/history'
import { replCompleter } from '../src/commands/repl'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { createSession } from '../src/store/queries'
import { Screen } from './fixtures/vt'

const keys = (...chunks: string[]): Key[] => {
  const d = keyDecoder()
  return chunks.flatMap((c) => d.push(c))
}

test('keys decode from what a terminal sends in raw mode', () => {
  expect(keys('ab\r')).toEqual([{ name: 'text', text: 'ab' }, { name: 'enter' }])
  expect(keys('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual([{ name: 'up' }, { name: 'down' }, { name: 'right' }, { name: 'left' }])
  expect(keys('\x1bOH\x1b[F\x1b[3~\x1b[1~\x1b[4~')).toEqual([{ name: 'home' }, { name: 'end' }, { name: 'delete' }, { name: 'home' }, { name: 'end' }])
  expect(keys('\x7f\b\t\x1b[Z')).toEqual([{ name: 'backspace' }, { name: 'backspace' }, { name: 'tab' }, { name: 'backtab' }])
  expect(keys('\x03\x04\x12')).toEqual([{ name: 'ctrl', key: 'c' }, { name: 'ctrl', key: 'd' }, { name: 'ctrl', key: 'r' }])
})

// every way a terminal can say "a new line, not send": Ctrl-J, Alt+Enter, and Shift+Enter under
// the kitty protocol and xterm's modifyOtherKeys
test('the newline keys are told apart from Enter', () => {
  expect(keys('\n', '\x1b\r', '\x1b[13;2u', '\x1b[27;2;13~')).toEqual([
    { name: 'newline' },
    { name: 'newline' },
    { name: 'newline' },
    { name: 'newline' },
  ])
})

test('word keys arrive as Alt and Ctrl sequences alike', () => {
  expect(keys('\x1bb\x1bf\x1b[1;5D\x1b[1;5C\x1b[1;3D\x1b\x7f\x1bd')).toEqual([
    { name: 'wordLeft' },
    { name: 'wordRight' },
    { name: 'wordLeft' },
    { name: 'wordRight' },
    { name: 'wordLeft' },
    { name: 'killWordLeft' },
    { name: 'killWordRight' },
  ])
})

test('a sequence split across reads is held until it completes; a lone ESC is the key', () => {
  expect(keys('\x1b[', 'A')).toEqual([{ name: 'up' }])
  expect(keys('x\x1b')).toEqual([{ name: 'text', text: 'x' }, { name: 'escape' }])
})

test('a bracketed paste is one key, carriage returns and all, even split mid-marker', () => {
  expect(keys('\x1b[200~one\r\ntwo\x1b[20', '1~z')).toEqual([{ name: 'paste', text: 'one\ntwo' }, { name: 'text', text: 'z' }])
  expect(keys('\x1b[200~a', 'b\x1b', '[201~')).toEqual([{ name: 'paste', text: 'ab' }])
  // a paste is never read as keys, so a newline or an escape inside it types nothing on its own
  expect(keys('\x1b[200~a\rb\x1b[Ac\x1b[201~')).toEqual([{ name: 'paste', text: 'a\nb\x1b[Ac' }])
})

const typed = (core: EditorCore, ...ks: Key[]) => ks.map((k) => core.handle(k))
const text = (t: string): Key => ({ name: 'text', text: t })
const k = (name: Exclude<Key['name'], 'text' | 'paste' | 'ctrl'>): Key => ({ name }) as Key
const ctrl = (key: string): Key => ({ name: 'ctrl', key })

test('editing moves by character, by word and by line, and deletes the same way', () => {
  const core = new EditorCore()
  typed(core, text('fix the token refresh'))
  typed(core, k('wordLeft'), k('wordLeft'))
  expect(core.buffer.slice(core.cursor)).toBe('token refresh')
  typed(core, ctrl('w'))
  expect(core.buffer).toBe('fix token refresh')
  typed(core, ctrl('k'))
  expect(core.buffer).toBe('fix ')
  typed(core, ctrl('a'), text('please '), ctrl('e'), text('it'))
  expect(core.buffer).toBe('please fix it')
  typed(core, ctrl('u'))
  expect(core.buffer).toBe('')
})

test('backspace and the arrows step over a character that is two code units', () => {
  const core = new EditorCore()
  typed(core, text('a😀b'), k('left'), k('left'), k('backspace'))
  expect(core.buffer).toBe('😀b')
  typed(core, k('end'), k('left'), k('backspace'))
  expect(core.buffer).toBe('b')
})

test('Enter sends; a trailing backslash or a newline key makes a second line instead', () => {
  const core = new EditorCore()
  typed(core, text('first \\'))
  expect(core.handle(k('enter'))).toEqual({ t: 'redraw' })
  typed(core, text('second'), k('newline'), text('third'))
  expect(core.handle(k('enter'))).toEqual({ t: 'submit', text: 'first \nsecond\nthird', echo: 'first \nsecond\nthird' })
  expect(core.buffer).toBe('')
})

test('history steps back and forward, and gives the half-written line back at the end', () => {
  const core = new EditorCore(['newest', 'older'])
  typed(core, text('draft'))
  typed(core, k('up'))
  expect(core.buffer).toBe('newest')
  typed(core, k('up'))
  expect(core.buffer).toBe('older')
  typed(core, k('up'))
  expect(core.buffer).toBe('older')
  typed(core, k('down'), k('down'))
  expect(core.buffer).toBe('draft')
})

test('up and down move between the lines of a multi-line entry before they reach history', () => {
  const core = new EditorCore(['from history'])
  typed(core, text('line one'), k('newline'), text('two'))
  typed(core, k('up'))
  expect(core.buffer).toBe('line one\ntwo')
  expect(core.cursor).toBe(3)
  typed(core, k('up'))
  expect(core.buffer).toBe('from history')
})

test('Ctrl-R finds the newest entry holding the query, again for the next one, and Enter takes it', () => {
  const core = new EditorCore(['run the tests', 'review the diff', 'run the linter'])
  typed(core, ctrl('r'), text('run'))
  expect(core.searchMatch()).toBe('run the tests')
  typed(core, ctrl('r'))
  expect(core.searchMatch()).toBe('run the linter')
  typed(core, k('enter'))
  expect(core.search).toBeNull()
  expect(core.buffer).toBe('run the linter')
})

test('Ctrl-C clears a line, arms the exit on an empty one, and a second press leaves', () => {
  const core = new EditorCore()
  typed(core, text('half'))
  expect(core.handle(ctrl('c'))).toEqual({ t: 'redraw' })
  expect(core.buffer).toBe('')
  expect(core.handle(ctrl('c'))).toEqual({ t: 'redraw' })
  expect(core.exitArmed).toBe(true)
  expect(core.handle(ctrl('c'))).toEqual({ t: 'exit' })
  // any other key disarms it
  const again = new EditorCore()
  typed(again, ctrl('c'), text('x'), ctrl('u'))
  expect(again.handle(ctrl('c'))).toEqual({ t: 'redraw' })
})

test('Ctrl-D leaves from an empty line and deletes forward otherwise', () => {
  const core = new EditorCore()
  typed(core, text('ab'), k('home'))
  expect(core.handle(ctrl('d'))).toEqual({ t: 'redraw' })
  expect(core.buffer).toBe('b')
  expect(new EditorCore().handle(ctrl('d'))).toEqual({ t: 'exit' })
})

test('Esc twice clears the line', () => {
  let clock = 0
  const core = new EditorCore([], () => null, () => clock)
  typed(core, text('oops'))
  core.handle(k('escape'))
  clock += 200
  core.handle(k('escape'))
  expect(core.buffer).toBe('')
})

test('a large paste is held under a placeholder, sent in full, and deleted as one piece', () => {
  const core = new EditorCore()
  const block = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n')
  typed(core, text('explain: '), { name: 'paste', text: block })
  expect(core.buffer).toBe('explain: [Pasted text #1 +8 lines]')
  typed(core, text(' please'))
  const sent = core.handle(k('enter'))
  expect(sent).toEqual({ t: 'submit', text: `explain: ${block} please`, echo: 'explain: [Pasted text #1 +8 lines] please' })

  const again = new EditorCore()
  typed(again, { name: 'paste', text: block }, k('backspace'))
  expect(again.buffer).toBe('')
  // a small paste is just text
  typed(again, { name: 'paste', text: 'two\nlines' })
  expect(again.buffer).toBe('two\nlines')
})

function completerFixture() {
  const db = openDb(':memory:')
  createSession(db, { slug: 'token-refresh', goal: 'fix it', cwd: '/x', lead: 'claude' })
  const cfg = configSchema.parse({ agents: { kiro: { enabled: false } } })
  return replCompleter(db, () => cfg)
}

test('a leading slash offers the commands that start with what was typed, then the ones that contain it', () => {
  const complete = completerFixture()
  const menu = complete('/us', 3)!
  expect(menu.items.map((i) => i.insert).slice(0, 2)).toEqual(['/use', '/usage'])
  expect(complete('/', 1)!.items.length).toBeGreaterThan(20)
  expect(complete('/zz', 3)).toBeNull()
})

test('the second word completes to what the command takes: agents, sessions, levels', () => {
  const complete = completerFixture()
  // what starts with the word first, then what merely contains it
  expect(complete('/use co', 7)!.items.map((i) => i.insert)).toEqual(['codex', 'opencode'])
  expect(complete('/use ', 5)!.items.find((i) => i.insert === 'kiro')!.detail).toBe('disabled')
  expect(complete('/resume tok', 11)!.items.map((i) => i.insert)).toEqual(['token-refresh'])
  expect(complete('/effort ', 8)!.items.map((i) => i.insert)).toEqual(['low', 'medium', 'high', 'max'])
  expect(complete('@op', 3)!.items.map((i) => i.insert)).toEqual(['@opencode'])
  expect(complete('fix the /use', 12)).toBeNull()
})

test('Tab accepts the selection; Enter runs a command that takes no argument, and waits for one that does', () => {
  const complete = completerFixture()
  const core = new EditorCore([], complete)
  typed(core, text('/he'))
  expect(core.menu()!.items[0]!.insert).toBe('/help')
  expect(core.handle(k('enter'))).toEqual({ t: 'submit', text: '/help', echo: '/help' })

  typed(core, text('/us'))
  typed(core, k('down'))
  expect(core.menu()!.items[core.selected]!.insert).toBe('/usage')
  typed(core, k('up'), k('enter'))
  // /use takes an agent: accepted with a space after it, not sent
  expect(core.buffer).toBe('/use ')
  typed(core, text('cod'), k('tab'))
  expect(core.buffer).toBe('/use codex ')
})

test('Esc closes the popup and the line stays as typed', () => {
  const core = new EditorCore([], completerFixture())
  typed(core, text('/st'))
  expect(core.menu()).not.toBeNull()
  typed(core, k('escape'))
  expect(core.menu()).toBeNull()
  expect(core.buffer).toBe('/st')
})

const spec: PromptSpec = {
  prompt: 'claude › ',
  placeholder: 'ask claude anything',
  footer: ['  s · 2 turns', 'opus · high  '],
  paint: { dim: (t) => t, accent: (t) => t, inverse: (t) => `[${t}]`, bold: (t) => t, yellow: (t) => t },
  shortcuts: [['/', 'commands'], ['esc', 'interrupt']],
}

const draw = (core: EditorCore, columns = 40) => {
  const d = renderEditor(core, spec, columns)
  const screen = new Screen(columns).write(d.lines.join('\n'))
  return { d, screen: screen.lines() }
}

test('the prompt sits between two rules with the footer under them, and an empty line shows the hint', () => {
  const { d, screen } = draw(new EditorCore())
  expect(screen[0]).toBe('─'.repeat(40))
  expect(screen[1]).toBe('claude › ask claude anything')
  expect(screen[2]).toBe('─'.repeat(40))
  expect(screen[3]).toMatch(/^ {2}s · 2 turns +opus · high$/)
  expect([d.row, d.col]).toEqual([1, 9])
})

test('a long line wraps inside the rules and the cursor is found on the row it wrapped to', () => {
  const core = new EditorCore()
  typed(core, text('x'.repeat(50)))
  const { d, screen } = draw(core)
  expect(screen[1]).toBe(`claude › ${'x'.repeat(31)}`)
  expect(screen[2]).toBe('x'.repeat(19))
  expect([d.row, d.col]).toEqual([2, 19])
  // the cursor after a row filled exactly moves to the start of the next
  const full = new EditorCore()
  typed(full, text('y'.repeat(31)))
  const f = draw(full)
  expect([f.d.row, f.d.col]).toEqual([2, 0])
})

test('the lines of a multi-line entry line up under the first one', () => {
  const core = new EditorCore()
  typed(core, text('one'), k('newline'), text('two'))
  expect(draw(core).screen.slice(1, 3)).toEqual(['claude › one', '         two'])
})

test('the popup replaces the footer and marks what Enter would take', () => {
  const core = new EditorCore([], completerFixture())
  typed(core, text('/us'))
  const { screen } = draw(core, 80)
  expect(screen[3]).toContain('❯ [ /use <agent>')
  expect(screen[4]).toContain('/usage')
  expect(screen.join('\n')).not.toContain('2 turns')
})

test('? on an empty line opens the shortcuts, and the first key after closes them', () => {
  const core = new EditorCore()
  typed(core, text('?'))
  expect(core.buffer).toBe('')
  expect(draw(core).screen.slice(3)).toEqual(['  /    commands', '  esc  interrupt'])
  typed(core, text('a'))
  expect(core.help).toBe(false)
})

// The terminal half: bytes in, a line out, and what is left on the screen afterwards.
function fakeTerminal(columns = 60) {
  const screen = new Screen(columns)
  let handler: ((c: Uint8Array) => void) | null = null
  const modes: boolean[] = []
  const input: RawInput = {
    on: (_e, h) => {
      handler = h
    },
    pause: () => {},
    resume: () => {},
    setRawMode: (on) => modes.push(on),
    isTTY: true,
  }
  const history = memoryHistory()
  const editor = terminalEditor({ input, write: (t) => screen.write(t), columns: () => columns, rows: () => 30, history, completer: () => null })
  return { screen, editor, modes, history, type: (s: string) => handler?.(new TextEncoder().encode(s)) }
}

test('a line typed at the terminal comes back submitted, and the prompt leaves only its echo behind', async () => {
  const t = fakeTerminal()
  const line = t.editor.read(() => spec)
  t.type('hello')
  t.type(' world\r')
  expect(await line).toBe('hello world')
  expect(t.screen.lines()).toEqual(['claude › hello world'])
  expect(t.history.entries()).toEqual(['hello world'])
  // raw for the read, cooked again after it
  expect(t.modes).toEqual([true, false])
})

test('what is typed during a turn waits for the next prompt, and Esc stops the turn', async () => {
  const t = fakeTerminal()
  let aborted = false
  const turn = t.editor.busy(
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        })
        t.type('next question')
        t.type('\x1b')
      }),
  )
  await turn
  expect(aborted).toBe(true)
  const line = t.editor.read(() => spec)
  t.type('\r')
  expect(await line).toBe('next question')
})

test('Ctrl-D on an empty prompt leaves, taking the prompt off the screen', async () => {
  const t = fakeTerminal()
  const line = t.editor.read(() => spec)
  t.type('\x04')
  expect(await line).toBeNull()
  expect(t.screen.text()).toBe('')
})
