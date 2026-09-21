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
  { name: 'new', aliases: ['start'], usage: 'new "<goal>"', summary: 'create a session in this directory' },
  { name: 'send', aliases: [], usage: 'send <agent> "<msg>"', summary: 'run one turn against one agent' },
  { name: 'ls', aliases: ['sessions'], usage: 'ls', summary: 'list sessions' },
  { name: 'resume', aliases: [], usage: 'resume [session]', summary: 'make a session current and show its roster' },
  { name: 'config', aliases: [], usage: 'config get|set', summary: 'read or write layered configuration' },
  {
    name: 'rm',
    aliases: [],
    usage: 'rm <session> --yes',
    summary: 'delete a konvoy session (foreign sessions survive)',
  },
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

// The two-column command listing used by USAGE, generated from the table so it can't
// drift from what dispatch actually supports.
export function formatCommandList(): string {
  const prefixes = commandTable.map((c) => `konvoy ${c.usage}`)
  const width = Math.max(...prefixes.map((p) => p.length))
  return commandTable
    .map((c, i) => {
      const prefix = prefixes[i]!
      const gap = ' '.repeat(Math.max(2, width - prefix.length))
      return `  ${prefix}${gap}${c.summary}`
    })
    .join('\n')
}
