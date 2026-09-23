import { expect, test } from 'bun:test'

// "Bun only, no node:* imports" lived in prose alone, which is the state every other rule in
// this repo got a test for. A node: specifier compiles and passes the suite here and only shows
// up later: the shipped binary embeds a Node shim for it, and the polyfill's behavior is not
// always Bun's own (node:sqlite against bun:sqlite is the one that would hurt most).
const NODE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]node:([a-zA-Z_/-]+)['"]/g

async function scan(dir: string): Promise<{ file: string; specifier: string }[]> {
  const root = new URL(`../${dir}`, import.meta.url).pathname
  const found: { file: string; specifier: string }[] = []
  for await (const rel of new Bun.Glob('**/*.ts').scan({ cwd: root })) {
    const text = await Bun.file(`${root}/${rel}`).text()
    for (const m of text.matchAll(NODE_IMPORT)) found.push({ file: `${dir}/${rel}`, specifier: `node:${m[1]}` })
  }
  return found
}

test('nothing under src/ or scripts/ imports a node: module', async () => {
  const offenders = [...(await scan('src')), ...(await scan('scripts'))]
  const named = offenders.map((o) => `${o.file} imports ${o.specifier}`)
  expect(named).toEqual([])
})

test('the scan reads real files and would see a node: import if one appeared', async () => {
  // A guard that scans nothing passes forever. This pins both halves: the glob found source,
  // and the pattern matches the import forms a real file would use.
  const root = new URL('../src', import.meta.url).pathname
  let files = 0
  for await (const _ of new Bun.Glob('**/*.ts').scan({ cwd: root })) files++
  expect(files).toBeGreaterThan(20)

  const forms = [
    "import { readFile } from 'node:fs/promises'",
    'import { join } from "node:path"',
    "await import('node:os')",
    "const { x } = require('node:child_process')",
    "import 'node:crypto'",
  ]
  for (const form of forms) expect(form.match(NODE_IMPORT), form).not.toBeNull()
  expect("import { openDb } from '../src/store/db'".match(NODE_IMPORT)).toBeNull()
  expect("import type { Database } from 'bun:sqlite'".match(NODE_IMPORT)).toBeNull()
})
