import { expect, test } from 'bun:test'
import { EditorCore, keyDecoder, PickerCore, renderEditor, renderPicker, terminalEditor, type Key, type PickSpec, type PromptSpec, type RawInput } from '../src/editor'
import { memoryHistory } from '../src/history'
import { replCompleter } from '../src/commands/repl'
import { openDb } from '../src/store/db'
import { configSchema } from '../src/config/schema'
import { createSession } from '../src/store/queries'
import { Screen } from './fixtures/vt'

// every read, then the pause after the last: a lone ESC left at the end is the Escape key
const keys = (...chunks: string[]): Key[] => {
  const d = keyDecoder()
  return [...chunks.flatMap((c) => d.push(c)), ...d.flush()]
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

// A focus report split after its ESC was the Escape key, and Escape stops a running turn: konvoy
// said "interrupted" to someone who had pressed nothing, just after a TUI left the reports on.
test('an ESC that the next read continues is the start of a sequence, never the Escape key', () => {
  const d = keyDecoder()
  expect(d.push('\x1b')).toEqual([])
  expect(d.holding()).toBe(true)
  expect(d.push('[I')).toEqual([])
  expect(d.holding()).toBe(false)
  expect(d.flush()).toEqual([])
})

test("a terminal's replies are dropped whole instead of typed into the line", () => {
  expect(keys('a\x1b]11;rgb:1e1e/1e1e/1e1e\x07b')).toEqual([{ name: 'text', text: 'ab' }])
  expect(keys('\x1b]11;rgb:0000/', '0000/0000\x1b\\c')).toEqual([{ name: 'text', text: 'c' }])
  expect(keys('\x1bP>|WezTerm 2026\x1b\\d')).toEqual([{ name: 'text', text: 'd' }])
  expect(keys('\x1b[?62;22c\x1b[O\x1b[Ie')).toEqual([{ name: 'text', text: 'e' }])
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
  // /use needs no word: alone it opens the list to pick from, so Enter runs it
  expect(typed(core, k('up'), k('enter')).at(-1)).toEqual({ t: 'submit', text: '/use', echo: '/use' })
  // /goal does take one: accepted with a space after it, not sent
  typed(core, text('/goa'), k('enter'))
  expect(core.buffer).toBe('/goal ')
  core.setBuffer('/use cod')
  typed(core, k('tab'))
  // the agent completes the command, so it is ready to run as it stands
  expect(core.buffer).toBe('/use codex')
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
  paint: { dim: (t) => t, accent: (t) => t, bold: (t) => t, yellow: (t) => t },
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
  expect(screen[3]).toContain('❯ /use [agent|konvoy]')
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

test('a focus report arriving in two reads during a turn does not stop it', async () => {
  const t = fakeTerminal()
  let aborted = false
  await t.editor.busy(async (signal) => {
    signal.addEventListener('abort', () => (aborted = true))
    t.type('\x1b')
    t.type('[O')
    await Bun.sleep(80)
  })
  expect(aborted).toBe(false)
  const line = t.editor.read(() => spec)
  t.type('ok\r')
  expect(await line).toBe('ok')
})

test('Ctrl-D on an empty prompt leaves, taking the prompt off the screen', async () => {
  const t = fakeTerminal()
  const line = t.editor.read(() => spec)
  t.type('\x04')
  expect(await line).toBeNull()
  expect(t.screen.text()).toBe('')
})

test('history is kept per project, newest first, without repeats, and trimmed', async () => {
  const { storeHistory } = await import('../src/history')
  const db = openDb(':memory:')
  const here = storeHistory(db, '/repo')
  here.add('first')
  here.add('second')
  here.add('second')
  here.add('first')
  storeHistory(db, '/other').add('elsewhere')
  expect(here.entries()).toEqual(['first', 'second'])
  expect(storeHistory(db, '/other').entries()).toEqual(['elsewhere'])
})

// Each REPL rewrote a shared history file from its own copy, so the second to write erased the
// first one's entries. In the store, two REPLs are two writers SQLite already serialises.
test('two prompts sharing one store keep each other entries', async () => {
  const { storeHistory } = await import('../src/history')
  const path = `/tmp/konvoy-test-history-${Bun.nanoseconds()}/konvoy.db`
  const a = storeHistory(openDb(path), '/x')
  const b = storeHistory(openDb(path), '/x')
  a.add('deploy it')
  b.add('fix tests')
  a.add('ship')
  expect(storeHistory(openDb(path), '/x').entries()).toEqual(['ship', 'fix tests', 'deploy it'])
})

test('a tab is drawn as the one cell the layout counts, and kept as a tab in the line', () => {
  const core = new EditorCore()
  typed(core, { name: 'paste', text: 'a\tb' })
  const { d, screen } = draw(core)
  expect(screen[1]).toBe('claude › a b')
  expect(d.col).toBe(12)
  expect(core.buffer).toBe('a\tb')
})

test('a command completed by its one word runs on Enter', () => {
  const core = new EditorCore([], completerFixture())
  typed(core, text('/effort hi'))
  expect(core.handle(k('enter'))).toEqual({ t: 'submit', text: '/effort high', echo: '/effort high' })
})

// ---- the picker: `/model` opened a list instead of asking for a name nobody could know

const models: PickSpec = {
  title: 'Model for opencode',
  items: [
    { value: 'default', label: 'default', detail: "opencode's own" },
    { value: 'opencode/claude-opus-5-5', label: 'opencode/claude-opus-5-5', current: true },
    { value: 'opencode/claude-sonnet-5', label: 'opencode/claude-sonnet-5' },
    { value: 'anthropic/gpt-6', label: 'anthropic/gpt-6', disabled: 'needs a key' },
  ],
}

test('the picker starts on the value in force, moves with the arrows, and chooses with Enter', () => {
  const p = new PickerCore(models)
  expect(p.selected).toBe(1)
  expect(p.handle({ name: 'down' })).toEqual({ t: 'redraw' })
  expect(p.handle({ name: 'enter' })).toEqual({ t: 'choose', value: 'opencode/claude-sonnet-5' })
  p.handle({ name: 'down' })
  // a row that cannot be chosen says why and is not chosen
  expect(p.handle({ name: 'enter' })).toEqual({ t: 'none' })
  p.handle({ name: 'down' })
  expect(p.selected).toBe(0)
})

test('typing filters the list, a digit picks a row, and Esc clears the filter before it closes', () => {
  const p = new PickerCore(models)
  expect(p.handle({ name: 'text', text: '1' })).toEqual({ t: 'choose', value: 'default' })
  for (const ch of 'sonnet') p.handle({ name: 'text', text: ch })
  expect(p.visible().map((r) => r.value)).toEqual(['opencode/claude-sonnet-5'])
  expect(p.handle({ name: 'escape' })).toEqual({ t: 'redraw' })
  expect(p.visible()).toHaveLength(4)
  expect(p.handle({ name: 'escape' })).toEqual({ t: 'cancel' })
})

test('a picker that takes free text offers what was typed as its own row', () => {
  const p = new PickerCore({ ...models, custom: { label: (t) => `use "${t}"` } })
  for (const ch of 'my-own-model') p.handle({ name: 'text', text: ch })
  expect(p.visible().at(-1)).toEqual({ value: 'my-own-model', label: 'use "my-own-model"' })
  expect(p.handle({ name: 'enter' })).toEqual({ t: 'choose', value: 'my-own-model' })
  // without custom, text that matches nothing chooses nothing
  const strict = new PickerCore(models)
  for (const ch of 'zzz') strict.handle({ name: 'text', text: ch })
  expect(strict.handle({ name: 'enter' })).toEqual({ t: 'none' })
})

const pickPaint = { dim: (t: string) => t, accent: (t: string) => `<${t}>`, bold: (t: string) => t }

test('the picker draws its title, numbered rows, the pointer, the tick and the keys', () => {
  const lines = renderPicker(new PickerCore(models), models, 60, pickPaint)
  expect(lines[1]).toBe(' Model for opencode')
  expect(lines).toContain("   1. default                     opencode's own")
  expect(lines).toContain('< ❯> <2. opencode/claude-opus-5-5>< ✔>')
  expect(lines).toContain('   4. anthropic/gpt-6             (needs a key)')
  expect(lines.at(-1)).toBe(' type to filter · ↑↓ · enter to choose · esc to cancel')
})

test('a long list scrolls around the cursor and says how much is hidden', () => {
  const many: PickSpec = { title: 't', items: Array.from({ length: 30 }, (_, i) => ({ value: `m-${i}`, label: `m-${i}` })) }
  const p = new PickerCore(many)
  for (let i = 0; i < 15; i++) p.handle({ name: 'down' })
  const lines = renderPicker(p, many, 60, pickPaint, 5)
  expect(lines.some((l) => l.includes('↑ 11 more'))).toBe(true)
  expect(lines.some((l) => l.includes('↓ 14 more'))).toBe(true)
  expect(lines.some((l) => l.includes('<16. m-15>'))).toBe(true)
})

test('pick at the terminal returns the choice and leaves nothing of the list on screen', async () => {
  const t = fakeTerminal()
  // colour takes no cells on a terminal; the bracketing paint above would wrap these rows
  const plain = { dim: (x: string) => x, accent: (x: string) => x, bold: (x: string) => x }
  const chosen = t.editor.pick(models, plain)
  t.type('\x1b[B')
  t.type('\r')
  expect(await chosen).toBe('opencode/claude-sonnet-5')
  expect(t.screen.text()).toBe('')
  const closed = t.editor.pick(models, plain)
  t.type('\x1b')
  await Bun.sleep(60)
  expect(await closed).toBeNull()
})

// a line that will run in a shell is framed in its own colour before Enter is pressed
test('the input is framed in the shell colour while the line starts with !', () => {
  const tinted: PromptSpec = { ...spec, paint: { ...spec.paint, yellow: (t) => `Y${t}` } }
  const core = new EditorCore()
  typed(core, text('!git status'))
  const lines = renderEditor(core, tinted, 30).lines
  expect(lines[0]).toStartWith('Y─')
  expect(lines[2]).toStartWith('Y─')
  core.setBuffer('git status')
  expect(renderEditor(core, tinted, 30).lines[0]).toStartWith('─')
})

// "/config set" and Enter took `set` from the popup as a word to complete, adding a space, and never
// ran the line: the list of keys it opens on its own never appeared
test('Enter on a /config subcommand the popup offers runs the line', () => {
  const core = new EditorCore([], completerFixture())
  typed(core, text('/config set'))
  expect(core.menu()?.items.map((i) => i.insert)).toContain('set')
  expect(core.handle(k('enter'))).toEqual({ t: 'submit', text: '/config set', echo: '/config set' })
})
