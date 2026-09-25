// Single source of truth for konvoy's command surface: name, aliases, usage line and
// one-line summary. src/cli.ts derives both its dispatch table and its USAGE text from
// this array, and tests/docs.test.ts checks README.md against it, so a command can't be
// documented without existing, or exist without being documented.
export interface CommandSpec {
  readonly name: string
  readonly aliases: readonly string[]
  readonly usage: string
  readonly summary: string
  /** the flags this command reads, beyond the ones every command takes, each with its help line */
  readonly flags: Readonly<Record<string, string>>
}

/** what a flag that takes a value is given, as its help shows it; every other flag is a switch */
export const FLAG_VALUES: Readonly<Record<string, string>> = {
  lead: '<agent>',
  limit: 'N',
  id: '<session-id>',
  via: '<how>',
  port: 'N',
  session: '<slug>',
}

export const commandTable = [
  { name: 'new', aliases: ['start'], usage: 'new ["<goal>"] [--lead <agent>]', summary: 'create a session in this directory', flags: { lead: 'the agent that leads the session and answers first' } },
  { name: 'send', aliases: [], usage: 'send <agent> "<msg>"', summary: 'run one turn against one agent (- reads stdin)', flags: {} },
  { name: 'ls', aliases: ['sessions', 'list'], usage: 'ls [--json]', summary: 'list sessions', flags: { json: 'print the sessions as JSON' } },
  { name: 'resume', aliases: [], usage: 'resume [session]', summary: 'make a session current and show its roster', flags: {} },
  { name: 'log', aliases: ['history'], usage: 'log [--limit N] [--json]', summary: 'recent turns: who, what, how each ended',
    flags: { limit: 'how many turns to show, newest first (20 by default)', json: 'print the turns as JSON' },
  },
  { name: 'show', aliases: ['last'], usage: 'show [N]', summary: 'print a turn in full, the latest by default', flags: {} },
  { name: 'config', aliases: [], usage: 'config get|set|unset|path', summary: 'read or write layered configuration',
    flags: { global: 'use the global file, ~/.config/konvoy/config.jsonc, instead of the project one' },
  },
  {
    name: 'rm',
    aliases: [],
    usage: 'rm <session> --yes',
    summary: 'delete a konvoy session (foreign sessions survive)',
    flags: { yes: 'confirm the delete; nothing is removed without it' },
  },
  { name: 'rename', aliases: [], usage: 'rename <session> <new-name>', summary: 'rename a session; its .konvoy folder follows', flags: {} },
  { name: 'roster', aliases: ['agents'], usage: 'roster [--json]', summary: 'who is in the convoy', flags: { json: 'print the roster as JSON' } },
  { name: 'usage', aliases: ['cost'], usage: 'usage [--all] [--chart] [--json]', summary: 'what this session spent, per agent',
    flags: { all: 'every session, not only this one', chart: "add turns per day and each agent's share", json: 'print the numbers as JSON' },
  },
  { name: 'status', aliases: [], usage: 'status', summary: 'versions, auth and roster', flags: {} },
  {
    name: 'attach',
    aliases: [],
    usage: 'attach <agent> [--id <session-id>]',
    summary: "open that agent's own interface, same session",
    flags: { id: "adopt a session started in the agent's own interface; later turns resume it" },
  },
  {
    name: 'doctor',
    aliases: [],
    usage: 'doctor',
    summary: 'check installs, logins, effort and model overlap',
    flags: {},
  },
  {
    name: 'install',
    aliases: [],
    usage: 'install [agent...|--all]',
    summary: "install agent CLIs with each vendor's own installer",
    flags: {
      all: 'every agent that is not installed yet',
      via: 'install with script, npm, brew or bun, instead of the first one available',
      yes: 'run without asking; with no terminal to answer at, nothing runs without it',
      'dry-run': 'print what would run, and run nothing',
    },
  },
  {
    name: 'update',
    aliases: ['upgrade'],
    usage: 'update [agent...|--all]',
    summary: 'update agent CLIs, and konvoy, the way each was installed',
    flags: { all: 'every installed agent, then konvoy itself', 'dry-run': 'print what would run, and run nothing' },
  },
  { name: 'version', aliases: [], usage: 'version', summary: 'konvoy and agent versions', flags: {} },
  { name: 'dashboard', aliases: [], usage: 'dashboard [--port N] [--no-open]', summary: 'open a local page with the same numbers',
    flags: { port: 'the port to serve on (any free one by default)', 'no-open': 'serve the page without opening a browser' },
  },
  { name: 'completion', aliases: [], usage: 'completion bash|zsh|fish', summary: 'print a shell completion script', flags: {} },
  { name: 'help', aliases: [], usage: 'help [command]', summary: "every command, or one command's usage and flags", flags: {} },
] as const satisfies readonly CommandSpec[]

export type CommandName = (typeof commandTable)[number]['name']

const aliasToName = new Map<string, CommandName>()
for (const c of commandTable) {
  aliasToName.set(c.name, c.name)
  for (const alias of c.aliases) aliasToName.set(alias, c.name)
}

// Resolves a typed word (a command name or one of its aliases) to its canonical command
// name, or undefined if it isn't a known command at all.
export function resolveCommandName(word: string): CommandName | undefined {
  return aliasToName.get(word)
}

// A user who types a word konvoy does not have is usually one letter or one habit away from the
// one it does: /list for ls, /sessons for sessions. Naming the nearest match is the difference
// between a dead end and a command, and it costs a table scan.
export function nearestCommand(word: string): CommandName | undefined {
  const target = word.toLowerCase()
  if (target === '') return undefined
  let best: { name: CommandName; score: number } | null = null
  for (const candidate of aliasToName.keys()) {
    const score = distance(target, candidate)
    const limit = Math.max(1, Math.floor(candidate.length / 3))
    if (score > limit) continue
    if (!best || score < best.score) best = { name: aliasToName.get(candidate)!, score }
  }
  return best?.name
}

// Levenshtein, two rows. Small enough not to be worth a dependency, and the table is tiny.
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost)
    }
    previous = current
  }
  return previous[b.length]!
}

/** the flags every command takes, wherever it is run from */
export const GLOBAL_FLAGS = ['session', 'help', 'h', 'version', 'v', 'V'] as const

// A flag konvoy does not read was ignored, and a value flag takes the word after it: so
// `konvoy send codex --sesion other "fix it"` ran against the CURRENT session with "other" thrown
// away. A typo in a flag is refused by name, with the flag it was probably meant to be.
export function unknownFlag(name: CommandName, flags: Record<string, unknown>): string | null {
  const known = new Set<string>([...GLOBAL_FLAGS, ...Object.keys(commandTable.find((c) => c.name === name)!.flags)])
  const stray = Object.keys(flags).find((f) => !known.has(f))
  if (stray === undefined) return null
  const dash = stray.length === 1 ? '-' : '--'
  const near = [...known].filter((k) => k.length > 1).find((k) => distance(stray, k) <= Math.max(1, Math.floor(k.length / 3)))
  return near ? `unknown flag ${dash}${stray} for ${name} - did you mean --${near}?` : `unknown flag ${dash}${stray} for ${name}`
}

export interface CommandRow {
  /** the invocation as a user types it, without the leading `konvoy ` or `/` */
  usage: string
  summary: string
}

// One two-column renderer for both listings. The REPL used to post-process USAGE's output with
// replaceAll('  konvoy ', '  /'), which also rewrote the word "konvoy" inside a summary: the
// `version` row read "/and agent versions". Prefix and rows are arguments now, so nothing has to
// be edited back out afterwards, and both listings line up on one width.
export function formatRows(prefix: string, rows: readonly CommandRow[]): string {
  const left = rows.map((r) => `${prefix}${r.usage}`)
  const width = Math.max(...left.map((l) => l.length)) + 2
  return rows.map((r, i) => `  ${left[i]!.padEnd(width)}${r.summary}`).join('\n')
}

// The two-column command listing used by USAGE, generated from the table so it can't
// drift from what dispatch actually supports.
export function formatCommandList(): string {
  return formatRows('konvoy ', commandTable)
}

// `konvoy <command> --help`, `konvoy help <command>` and the REPL's `/help <command>`: one
// command's usage, what it does, and each flag it reads - the page the agents' own CLIs give a
// subcommand, instead of the whole list again.
export function commandHelp(word: string, prefix = 'konvoy '): string | null {
  const name = resolveCommandName(word)
  if (!name) return null
  const c: CommandSpec = commandTable.find((x) => x.name === name)!
  const flags = Object.entries(c.flags).map(([f, help]) => ({ usage: `--${f}${FLAG_VALUES[f] ? ` ${FLAG_VALUES[f]}` : ''}`, summary: help }))
  const lines = [`usage: ${prefix}${c.usage}`, '', `  ${c.summary}`]
  if (flags.length > 0) lines.push('', formatRows('', flags))
  if (c.aliases.length > 0) lines.push('', `also: ${c.aliases.map((a) => `${prefix}${a}`).join(', ')}`)
  return `${lines.join('\n')}\n`
}
