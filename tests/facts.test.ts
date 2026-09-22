import { expect, test } from 'bun:test'
import * as factsMod from '../src/core/facts'
import { newSession as newFactsSession } from '../src/core/session'
import { openDb as openFactsDb } from '../src/store/db'
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

test('a field containing the delimiter is quoted, so a row cannot shift', () => {
  // 48% of this repo's own commit subjects contain a comma - this is the common case
  const out = formatFacts({
    commits: [{ sha: 'a1b2c3d', subject: 'feat: single-binary build, update command and readme' }],
    files: [{ path: 'src/a,b.ts', added: 1, removed: 2 }],
    agents: [],
  })
  expect(out).toContain('a1b2c3d,"feat: single-binary build, update command and readme"')
  expect(out).toContain('"src/a,b.ts",1,2')
})

test('a field containing a quote has it doubled, as csv requires', () => {
  const out = formatFacts({
    commits: [{ sha: 'a1b2c3d', subject: 'fix: the "brief" style, finally' }],
    files: [], agents: [],
  })
  expect(out).toContain('"fix: the ""brief"" style, finally"')
})

test('an ordinary field is not quoted, because quotes nobody needs are tokens nobody wanted', () => {
  const out = formatFacts({ commits: [{ sha: 'a1b2c3d', subject: 'plain subject' }], files: [], agents: [] })
  expect(out).toContain('a1b2c3d,plain subject')
  expect(out).not.toContain('"plain subject"')
})

// The turns half of the prelude is capped at three and says why (§29); the facts half was not
// capped at all - every commit since the session began and every changed file, prepended to
// every prompt for every agent. Thirty rows per section, and a count of what was left out.
test('a facts section shows at most thirty rows and says how many more there were', async () => {
  const db = openFactsDb(':memory:')
  const s = newFactsSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const log = Array.from({ length: 50 }, (_, i) => `${(1000000 + i).toString(16)} subject ${i}`).join('\n')
  const facts = await factsMod.collectFacts({ git: async (args) => (args[0] === 'log' ? log : '') }, db, s)
  const out = factsMod.formatFacts(facts)
  expect(out).toContain('commits[30]{sha,subject}:')
  expect(out).toContain('subject 29')
  expect(out).not.toContain('subject 30')
  expect(out).toContain('(+20 more commits)')
})
