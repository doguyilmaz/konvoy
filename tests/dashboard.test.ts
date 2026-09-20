import { expect, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { createSession, recordTurn } from '../src/store/queries'
import { configSchema } from '../src/config/schema'
import { collect, renderPage } from '../src/dashboard/page'

const cfg = configSchema.parse({})
const empty = { asOf: '', agents: [], days: [], byAgentDay: [], totals: { turns: 0, inputTokens: 0, outputTokens: 0 } }

test('collect summarises turns per agent and per day', () => {
  const db = openDb(':memory:')
  const s = createSession(db, { slug: 's', goal: 'g', cwd: '/x', lead: 'claude' })
  recordTurn(db, { sessionId: s.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 1, exitCode: 0, inputTokens: 10 })
  recordTurn(db, { sessionId: s.id, agent: 'codex', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, inputTokens: 20 })
  const data = collect(db, cfg, s.id)
  expect(data.agents.map((a) => a.agent).sort()).toEqual(['claude', 'codex'])
  expect(data.days.length).toBeGreaterThan(0)
  expect(data.byAgentDay.length).toBeGreaterThan(0)
})

test('the page is self-contained: no external script or stylesheet', () => {
  const html = renderPage({ ...empty, title: 'demo' })
  expect(html).toContain('<!doctype html>')
  expect(html).not.toContain('<script src=')
  expect(html).not.toContain('<link rel="stylesheet"')
  expect(html).not.toContain('cdn')
})

test('the page escapes text that came from the database', () => {
  const html = renderPage({ ...empty, title: '<img src=x onerror=alert(1)>' })
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;img')
})

test('an unpriced agent shows a dash, never a zero cost', () => {
  const html = renderPage({
    ...empty,
    title: 'unpriced',
    agents: [{ agent: 'codex', turns: 3, inputTokens: 9, outputTokens: 1, spend: '-', estimateUsd: null }],
  })
  expect(html).toContain('-')
  expect(html).not.toContain('$0.00')
})

test('an empty database renders a page rather than throwing', () => {
  const db = openDb(':memory:')
  const data = collect(db, cfg)
  expect(renderPage({ ...data, title: 'empty' })).toContain('<!doctype html>')
})

// --- additional regression coverage beyond the brief's fixed cases ---

test('collect scopes to its sessionId and does not leak other sessions', () => {
  const db = openDb(':memory:')
  const a = createSession(db, { slug: 'a', goal: 'g', cwd: '/a', lead: 'claude' })
  const b = createSession(db, { slug: 'b', goal: 'g', cwd: '/b', lead: 'claude' })
  recordTurn(db, { sessionId: a.id, agent: 'claude', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, inputTokens: 1 })
  recordTurn(db, { sessionId: b.id, agent: 'kiro', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, inputTokens: 1 })
  recordTurn(db, { sessionId: b.id, agent: 'kiro', prompt: 'p', final: 'f', costUsd: 0, exitCode: 0, inputTokens: 1 })

  const dataA = collect(db, cfg, a.id)
  expect(dataA.agents.map((r) => r.agent)).toEqual(['claude'])
  expect(dataA.totals.turns).toBe(1)

  const dataAll = collect(db, cfg)
  expect(dataAll.totals.turns).toBe(3)
})

test('per-agent bars share one scale: a quiet agent never draws as tall as a busy one', () => {
  const html = renderPage({
    ...empty,
    title: 'scale',
    byAgentDay: [
      { agent: 'quiet', day: '2026-01-01', count: 2 },
      { agent: 'busy', day: '2026-01-01', count: 20 },
      { agent: 'busy', day: '2026-01-02', count: 20 },
    ],
  })

  const heightsFor = (agent: string): number[] => {
    const rowMatch = html.match(new RegExp(`data-agent="${agent}"[\\s\\S]*?</div>`))
    expect(rowMatch).not.toBeNull()
    return [...rowMatch![0].matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]))
  }

  const quietMax = Math.max(...heightsFor('quiet'))
  const busyMax = Math.max(...heightsFor('busy'))
  // real ratio is 2/20 = 0.1 under a shared scale; a per-row scale would make both bars
  // draw at their own full height, i.e. quietMax === busyMax
  expect(quietMax).toBeLessThan(busyMax * 0.5)
})

test('the dashboard command binds explicitly to loopback, never every interface', async () => {
  // Bun.serve defaults to 0.0.0.0 when hostname is omitted; this page has no auth, so the
  // literal must stay pinned. Asserted at the source level because cmdDashboard blocks
  // forever (`await new Promise(() => {})`) and never returns a handle to the server.
  const src = await Bun.file(new URL('../src/commands/dashboard.ts', import.meta.url)).text()
  expect(src).toMatch(/hostname:\s*['"]127\.0\.0\.1['"]/)
})
