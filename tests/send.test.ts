import { expect, spyOn, test } from 'bun:test'
import { openDb } from '../src/store/db'
import { newSession } from '../src/core/session'
import { configSchema } from '../src/config/schema'
import { cmdSend, decideOutcome } from '../src/commands/send'
import type { TurnResult } from '../src/core/turn'

function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    final: '',
    foreignId: null,
    costUsd: 0,
    credits: 0,
    inputTokens: 0,
    outputTokens: 0,
    exitCode: 0,
    error: null,
    events: [],
    warnings: [],
    ...over,
  }
}

test('a clean turn prints its output and exits 0', () => {
  const outcome = decideOutcome('claude', result({ final: 'done' }))
  expect(outcome).toEqual({ code: 0, stdout: 'done', stderrLines: [] })
})

test('a rate limit hit after real output is reported as blocked, not failed', () => {
  const outcome = decideOutcome('claude', result({ final: 'partial answer', error: { message: "hit your session limit · resets 7am", kind: 'rate' } }))
  expect(outcome.code).toBe(0)
  expect(outcome.stdout).toBe('partial answer')
  expect(outcome.stderrLines).toEqual([
    'claude is blocked (rate): hit your session limit · resets 7am',
    'konvoy send <another agent> …, or set failover.chain to move on by itself',
  ])
})

test('an auth error after real output is reported as blocked, with the login hint', () => {
  const outcome = decideOutcome('codex', result({ final: 'partial', error: { message: 'token expired', kind: 'auth' } }))
  expect(outcome.code).toBe(0)
  expect(outcome.stdout).toBe('partial')
  expect(outcome.stderrLines).toEqual(['codex is blocked (auth): token expired', 'run: codex login'])
})

test('an error with no output is still a total failure', () => {
  const outcome = decideOutcome('claude', result({ final: '', error: { message: 'boom', kind: 'crash' } }))
  expect(outcome.code).toBe(1)
  expect(outcome.stdout).toBe(null)
  expect(outcome.stderrLines).toEqual(['claude failed (crash): boom'])
})

test('a rate error with no output fails the turn, and still says the agent is blocked', () => {
  const outcome = decideOutcome('claude', result({ final: '   ', error: { message: 'quota exceeded', kind: 'rate' } }))
  expect(outcome.code).toBe(1)
  expect(outcome.stdout).toBe(null)
  expect(outcome.stderrLines[0]).toBe('claude is blocked (rate): quota exceeded')
})

// claude answers a rate limit with the limit's own sentence as the turn's text: printed as the
// answer and again as the error, the same line read twice
test("an answer that only repeats the error is not printed as an answer", () => {
  const said = "You've hit your weekly limit · resets 7am (Europe/Istanbul)"
  const outcome = decideOutcome('claude', result({ final: said, error: { message: said, kind: 'rate' } }))
  expect(outcome.code).toBe(1)
  expect(outcome.stdout).toBeNull()
  expect(outcome.stderrLines[0]).toBe(`claude is blocked (rate): ${said}`)
})

test('inside konvoy the next step names konvoy\'s own commands', () => {
  const rate = decideOutcome('claude', result({ error: { message: 'weekly limit', kind: 'rate' } }), { interactive: true })
  expect(rate.stderrLines[1]).toBe('shift+tab to another agent, or /use konvoy to move on by itself when one runs out')
  const auth = decideOutcome('antigravity', result({ error: { message: 'Eligibility check failed', kind: 'auth' } }), { interactive: true })
  expect(auth.stderrLines.slice(1)).toEqual(['sign in inside antigravity itself: /attach antigravity, then come back', 'run: agy and sign in (it has no auth subcommand)'])
  const model = decideOutcome('opencode', result({ error: { message: 'Invalid model reference: opus-5-5', kind: 'unknown' } }), { interactive: true })
  expect(model.stderrLines).toEqual(['opencode failed (unknown): Invalid model reference: opus-5-5', '/model to pick one opencode offers'])
})

// agy's sign-in refusal carries the one link that fixes it; cut at the cap it was a dead link
test('a URL the cap would cut is printed whole on a line of its own', () => {
  const url = `https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=${'x'.repeat(200)}`
  const message = `Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue. Alternatively, try signing in with another personal Google account. Please verify your account in your browser to continue: ${url}`
  const outcome = decideOutcome('antigravity', result({ error: { message, kind: 'auth' } }))
  expect(outcome.stderrLines[0]).toEndWith('…')
  expect(outcome.stderrLines[0]).not.toContain('https://')
  expect(outcome.stderrLines[1]).toBe(url)
})

test('send against an uninstalled agent prints the friendly line, not a raw spawn error', async () => {
  const db = openDb(':memory:')
  const s = newSession(db, { cwd: process.cwd(), goal: 'g', lead: 'claude' })
  const cfg = configSchema.parse({ agents: { codex: { bin: 'konvoy-test-nonexistent-binary-xyz' } } })
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const code = await cmdSend(db, cfg, process.cwd(), 'codex', 'hi', s.slug)
    expect(code).toBe(2)
    expect(err.mock.calls.some((c) => String(c[0]).includes('codex: not installed'))).toBe(true)
    expect(err.mock.calls.some((c) => String(c[0]).includes('ENOENT'))).toBe(false)
  } finally {
    err.mockRestore()
  }
})

// The two strings decideOutcome hands to the terminal come from the agent (final) and from the
// CLI or the agent (error.message, up to 64 KiB of stderr on a non-zero exit). Neither is
// printed raw: notices are one capped line, output keeps its newlines and nothing else.
test('what reaches the terminal carries no control bytes: notices one capped line, output keeps newlines', () => {
  const blocked = decideOutcome(
    'claude',
    result({ final: 'a\u001b[2Jb\nc', error: { message: 'hit your session limit\u001b[2K\nsecond line', kind: 'rate' } }),
  )
  expect(blocked.stdout).toBe('ab\nc')
  expect(blocked.stderrLines[0]).toBe('claude is blocked (rate): hit your session limit second line')

  const failed = decideOutcome('claude', result({ final: '', error: { message: 'x'.repeat(400), kind: 'crash' } }))
  expect(failed.stderrLines[0]).toHaveLength('claude failed (crash): '.length + 301)
})
