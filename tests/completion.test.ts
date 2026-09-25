import { expect, test } from 'bun:test'
import { completionScripts } from '../src/commands/completion'
import { commandTable } from '../src/commands/table'
import { agentIds } from '../src/config/schema'

// Generated from the command table, so a command added there is completed without touching this.
test('every script names every command, every agent and the session lookup', () => {
  for (const [shell, make] of Object.entries(completionScripts)) {
    const script = make()
    for (const c of commandTable) expect(script, `${shell}: ${c.name}`).toContain(c.name)
    for (const a of agentIds) expect(script, `${shell}: ${a}`).toContain(a)
    expect(script, shell).toContain('konvoy __complete sessions')
  }
})

test('each command offers the flags it reads, and no others', () => {
  const bash = completionScripts.bash()
  expect(bash).toMatch(/usage\|cost\) flags="--all --chart --json /)
  expect(bash).toMatch(/rm\) flags="--yes /)
  expect(bash).not.toMatch(/status\) flags=/)
})

test('the bash script is valid bash', async () => {
  const bash = Bun.which('bash')
  if (!bash) return
  const proc = Bun.spawn([bash, '-n'], { stdin: new Response(completionScripts.bash()), stderr: 'pipe' })
  expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0)
})

test('a summary with a quote in it survives each shell quoting rule', () => {
  // attach's summary is "open that agent's own interface" - one apostrophe, three quoting schemes
  expect(completionScripts.zsh()).toContain(`'attach:open that agent'\\''s own interface, same session'`)
  expect(completionScripts.fish()).toContain(`'open that agent\\'s own interface, same session'`)
})
