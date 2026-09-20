import { expect, test } from 'bun:test'
import { commandTable, resolveCommandName } from '../src/commands/table'
import { configSchema } from '../src/config/schema'
import { stripJsonc } from '../src/config/load'

const readme = await Bun.file(new URL('../README.md', import.meta.url)).text()

function fencedBlocks(lang: string): string[] {
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g')
  return [...readme.matchAll(re)].map((m) => m[1]!)
}

// Every `konvoy <word>` invocation the README actually shows a reader — inside ```bash
// fences (comments stripped) and inline `konvoy ...` code spans — not prose mentions of
// the word "konvoy" itself.
function konvoyInvocations(): string[] {
  const words: string[] = []

  for (const block of fencedBlocks('bash')) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.split('#')[0]!.trim()
      const m = line.match(/^konvoy\s+(\S+)/)
      if (m) words.push(m[1]!)
    }
  }

  for (const m of readme.matchAll(/`(konvoy\s+\S+)[^`]*`/g)) {
    const w = m[1]!.match(/^konvoy\s+(\S+)/)
    if (w) words.push(w[1]!)
  }

  return words
}

test('every command in the table is documented in README.md', () => {
  for (const c of commandTable) {
    expect(readme).toContain(`konvoy ${c.name}`)
  }
})

test('every "konvoy <word>" shown in README.md is a real command or alias', () => {
  const words = konvoyInvocations()
  expect(words.length).toBeGreaterThan(0)
  for (const word of words) {
    expect(resolveCommandName(word)).toBeDefined()
  }
})

test('every --flag README.md mentions is read somewhere in the source', async () => {
  const flags = [...new Set([...readme.matchAll(/--[a-zA-Z][a-zA-Z0-9-]*/g)].map((m) => m[0]!))]
  expect(flags.length).toBeGreaterThan(0)

  const glob = new Bun.Glob('**/*.ts')
  const sources: string[] = []
  for await (const path of glob.scan({ cwd: new URL('../src', import.meta.url).pathname })) {
    sources.push(await Bun.file(new URL(`../src/${path}`, import.meta.url)).text())
  }
  const all = sources.join('\n')

  for (const flag of flags) {
    const name = flag.slice(2)
    expect(all).toMatch(new RegExp(`flags(\\.|\\[['"])${name}\\b`))
  }
})

test('every ```jsonc block in README.md parses against configSchema', () => {
  const blocks = fencedBlocks('jsonc')
  expect(blocks.length).toBeGreaterThan(0)
  for (const block of blocks) {
    const parsed = JSON.parse(stripJsonc(block))
    const result = configSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  }
})
