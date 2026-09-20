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
  expect(outcome.stderrLines).toEqual(['claude is blocked (rate): hit your session limit · resets 7am'])
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

test('a rate error with no output is still a total failure, not "blocked"', () => {
  const outcome = decideOutcome('claude', result({ final: '   ', error: { message: 'quota exceeded', kind: 'rate' } }))
  expect(outcome.code).toBe(1)
  expect(outcome.stdout).toBe(null)
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
