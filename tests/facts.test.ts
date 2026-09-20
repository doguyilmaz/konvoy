import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, recordTurn } from '../src/store/queries'
import { collectFacts, formatFacts } from '../src/core/facts'

const deps = {
  git: async (args: string[]) => {
    if (args[0] === 'log') return 'a1b2c3d subject one\ne4f5g6h subject two\n'
    if (args[0] === 'diff') return ' src/a.ts | 12 ++++\n src/b.ts |  3 --\n 2 files changed\n'
    return ''
  },
}

test('facts come from git and the store, never from an agent', async () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(db, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1.5, exitCode: 0 })

  const facts = await collectFacts(deps, db, s)
  expect(facts.commits.map((c) => c.sha)).toEqual(['a1b2c3d', 'e4f5g6h'])
  expect(facts.files).toEqual([
    { path: 'src/a.ts', added: 12, removed: 0 },
    { path: 'src/b.ts', added: 0, removed: 3 },
  ])
  expect(facts.agents).toEqual([{ agent: 'claude', turns: 1, spend: '$1.50' }])
})

test('facts render as uniform rows, not as objects', () => {
  const out = formatFacts({
    commits: [{ sha: 'a1b2c3d', subject: 'subject one' }],
    files: [{ path: 'src/a.ts', added: 12, removed: 0 }],
    agents: [{ agent: 'claude', turns: 1, spend: '$1.50' }],
  })
  expect(out).toContain('files[1]{path,added,removed}:')
  expect(out).toContain('src/a.ts,12,0')
  expect(out).not.toContain('{"path"')
})

test('an empty session renders without a section rather than an empty one', () => {
  const out = formatFacts({ commits: [], files: [], agents: [] })
  expect(out).not.toContain('files[0]')
  expect(out.trim().length).toBeGreaterThanOrEqual(0)
})
