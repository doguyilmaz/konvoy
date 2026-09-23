// Single source of truth for konvoy's command surface: name, aliases, usage line and
// one-line summary. src/cli.ts derives both its dispatch table and its USAGE text from
// this array, and tests/docs.test.ts checks README.md against it, so a command can't be
// documented without existing, or exist without being documented.
export interface CommandSpec {
  readonly name: string
  readonly aliases: readonly string[]
  readonly usage: string
  readonly summary: string
}

export const commandTable = [
  { name: 'new', aliases: ['start'], usage: 'new ["<goal>"]', summary: 'create a session in this directory' },
  { name: 'send', aliases: [], usage: 'send <agent> "<msg>"', summary: 'run one turn against one agent' },
  { name: 'ls', aliases: ['sessions', 'list'], usage: 'ls', summary: 'list sessions' },
  { name: 'resume', aliases: [], usage: 'resume [session]', summary: 'make a session current and show its roster' },
  { name: 'config', aliases: [], usage: 'config get|set', summary: 'read or write layered configuration' },
  {
    name: 'rm',
    aliases: [],
    usage: 'rm <session> --yes',
    summary: 'delete a konvoy session (foreign sessions survive)',
  },
  { name: 'rename', aliases: [], usage: 'rename <session> <new-name>', summary: 'rename a session; its .konvoy folder follows' },
  { name: 'roster', aliases: [], usage: 'roster', summary: 'who is in the convoy' },
  { name: 'usage', aliases: [], usage: 'usage [--all] [--chart]', summary: 'what this session spent, per agent' },
  { name: 'status', aliases: [], usage: 'status', summary: 'versions, auth and roster' },
  {
    name: 'attach',
    aliases: [],
    usage: 'attach <agent> [--id <session-id>]',
    summary: "open that agent's own interface, same session",
  },
  {
    name: 'doctor',
    aliases: [],
    usage: 'doctor',
    summary: 'check installs, logins, effort and model overlap',
  },
  {
    name: 'update',
    aliases: [],
    usage: 'update [--all]',
    summary: 'update konvoy, and with --all the agent CLIs',
  },
  { name: 'version', aliases: [], usage: 'version', summary: 'konvoy and agent versions' },
  { name: 'dashboard', aliases: [], usage: 'dashboard [--port N]', summary: 'open a local page with the same numbers' },
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
