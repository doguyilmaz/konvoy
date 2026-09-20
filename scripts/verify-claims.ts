import { agentIds, getAdapter } from '../src/adapters'
import type { AgentId, Binding, TurnContext } from '../src/types'

// bun run verify:claims — checks the claims konvoy's own docs make about the four agent
// CLIs against what --help actually says on this machine. This is the standing form of a
// manual check that already caught one stale belief (a `doctor` claim no command ever
// implemented); the other kind of stale belief — silent tilde in a `bin` path — is a
// separate, config-level bug this script does not reach.
//
// Every check is a --help / --version spawn. Never a prompt, never quota.

interface CheckResult {
  ok: boolean
  detail: string
}

interface Check {
  label: string
  run: () => Promise<CheckResult>
}

const TIMEOUT_MS = 10_000

async function run(cmd: string[]): Promise<{ exitCode: number; output: string } | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: TIMEOUT_MS })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { exitCode, output: stdout + stderr }
  } catch {
    return null
  }
}

function expandHome(p: string): string {
  if (!p.startsWith('~')) return p
  const home = Bun.env.HOME
  return home ? home + p.slice(1) : p
}

// konvoy's own README used to tell readers to write a `~` path into `bin` and let it
// silently do nothing — so this resolver expands `~` itself instead of trusting the shell.
async function resolveBin(candidates: string[]): Promise<string | null> {
  for (const raw of candidates) {
    const bin = expandHome(raw)
    if (await run([bin, '--version'])) return bin
  }
  return null
}

const BIN_CANDIDATES: Record<string, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  'kiro-cli': ['kiro-cli'],
  // opencode's own installer puts it here by default, off $PATH — the exact path the
  // README's config example points `bin` at.
  opencode: ['opencode', '~/.opencode/bin/opencode'],
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function updateCheck(name: keyof typeof BIN_CANDIDATES, args: string[]): Check {
  return {
    label: `${name} ${args[0]} subcommand exists`,
    run: async () => {
      const bin = await resolveBin(BIN_CANDIDATES[name])
      if (!bin) return { ok: false, detail: `${name} not found on this machine — cannot verify` }
      const result = await run([bin, ...args])
      if (!result) return { ok: false, detail: `${bin} ${args.join(' ')} failed to spawn` }
      if (result.exitCode !== 0) {
        return { ok: false, detail: `${bin} ${args.join(' ')} exited ${result.exitCode}: ${firstLine(result.output)}` }
      }
      return { ok: true, detail: `${bin} ${args.join(' ')} — exit 0` }
    },
  }
}

function helpCheck(
  name: keyof typeof BIN_CANDIDATES,
  helpArgs: string[],
  label: string,
  verify: (output: string) => CheckResult,
): Check {
  return {
    label,
    run: async () => {
      const bin = await resolveBin(BIN_CANDIDATES[name])
      if (!bin) return { ok: false, detail: `${name} not found on this machine — cannot verify` }
      const result = await run([bin, ...helpArgs])
      if (!result) return { ok: false, detail: `${bin} ${helpArgs.join(' ')} failed to spawn` }
      return verify(result.output)
    },
  }
}

const SESSION_ID_FLAG = /--session-id\b/
const SESSION_FLAG_LINE = /^.*--session\b.*$/m

const checks: Check[] = [
  updateCheck('claude', ['update', '--help']),
  updateCheck('codex', ['update', '--help']),
  updateCheck('kiro-cli', ['update', '--help']),
  updateCheck('opencode', ['upgrade', '--help']),

  helpCheck('claude', ['--help'], 'claude --session-id exists (a caller can set the session id)', (out) =>
    SESSION_ID_FLAG.test(out)
      ? { ok: true, detail: 'found in `claude --help`' }
      : { ok: false, detail: '--session-id is no longer in `claude --help`' },
  ),
  helpCheck(
    'codex',
    ['exec', '--help'],
    'codex has no --session-id equivalent (the binding design assumes this)',
    (out) =>
      SESSION_ID_FLAG.test(out)
        ? { ok: false, detail: 'codex now advertises --session-id in `codex exec --help`' }
        : { ok: true, detail: 'absent from `codex exec --help` — only `resume <id>` for an existing session' },
  ),
  helpCheck(
    'kiro-cli',
    ['chat', '--help'],
    'kiro-cli has no --session-id equivalent (the binding design assumes this)',
    (out) =>
      SESSION_ID_FLAG.test(out)
        ? { ok: false, detail: 'kiro-cli now advertises --session-id in `kiro-cli chat --help`' }
        : { ok: true, detail: 'absent from `kiro-cli chat --help` — only `--resume-id` for an existing session' },
  ),

  helpCheck('opencode', ['run', '--help'], 'opencode --session exists', (out) =>
    SESSION_FLAG_LINE.test(out)
      ? { ok: true, detail: 'found in `opencode run --help`' }
      : { ok: false, detail: '--session is no longer in `opencode run --help`' },
  ),
  helpCheck(
    'opencode',
    ['run', '--help'],
    'opencode --session continues a session rather than creating one with a chosen id',
    (out) => {
      const line = SESSION_FLAG_LINE.exec(out)?.[0] ?? ''
      return /continu/i.test(line)
        ? { ok: true, detail: `"${line.trim()}"` }
        : { ok: false, detail: `--session no longer reads as "continue": "${line.trim()}"` }
    },
  ),
]

// Every flag an adapter actually places on a command line, checked against that CLI's own
// --help. The captured fixtures prove each flag worked on the day of capture; this proves it
// still parses today. The list is built from the adapters' real argv across every permission,
// harness and binding state — not kept by hand — so a flag added to an adapter is checked here
// without anyone remembering to add it.
const AGENT_KEY: Record<AgentId, keyof typeof BIN_CANDIDATES> = { claude: 'claude', codex: 'codex', kiro: 'kiro-cli', opencode: 'opencode' }
const TURN_HELP: Record<AgentId, string[]> = { claude: ['--help'], codex: ['exec', '--help'], kiro: ['chat', '--help'], opencode: ['run', '--help'] }
const ATTACH_HELP: Record<AgentId, string[]> = { claude: ['--help'], codex: ['resume', '--help'], kiro: ['chat', '--help'], opencode: ['--help'] }

function argvFlags(cmd: string[]): string[] {
  return cmd.map((tok) => tok.split('=')[0]!).filter((tok) => /^--?[a-z][a-z-]*$/.test(tok) && tok !== '--')
}

function adapterFlags(id: AgentId): { turn: Set<string>; attach: Set<string> } {
  const adapter = getAdapter(id)
  const sessionId = '00000000-0000-4000-8000-000000000000'
  const bound: Binding = {
    sessionId, agent: id, foreignId: 'x', model: null, effort: 'high', permission: 'edit',
    status: 'bound', turns: 1, costUsd: 0, credits: 0, lastSeen: null,
  }
  const turn = new Set<string>()
  for (const permission of ['safe', 'edit', 'yolo'] as const) {
    for (const harness of ['minimal', 'inherit'] as const) {
      for (const binding of [null, bound]) {
        const ctx = {
          sessionId, slug: 's', cwd: '/tmp', sessionDir: '/tmp/.konvoy/s', prompt: 'p',
          binding, effort: 'high', permission, harness, model: 'm',
        } as unknown as TurnContext
        for (const flag of argvFlags(adapter.turn(ctx).cmd)) turn.add(flag)
      }
    }
  }
  return { turn, attach: new Set(argvFlags(adapter.attach(bound).cmd)) }
}

function mentions(help: string, flag: string): boolean {
  const escaped = flag.replace(/[-]/g, '\\-')
  return new RegExp(`(?:^|[\\s,\\[/])${escaped}(?=$|[\\s,=<\\[\\]])`, 'm').test(help)
}

function flagCheck(id: AgentId, kind: 'turn' | 'attach'): Check {
  return {
    label: `${id} ${kind}() flags all appear in its --help`,
    run: async () => {
      const bin = await resolveBin(BIN_CANDIDATES[AGENT_KEY[id]])
      if (!bin) return { ok: false, detail: `${id} not found on this machine — cannot verify` }
      const helpArgs = kind === 'turn' ? TURN_HELP[id] : ATTACH_HELP[id]
      const result = await run([bin, ...helpArgs])
      if (!result) return { ok: false, detail: `${bin} ${helpArgs.join(' ')} failed to spawn` }
      const flags = [...adapterFlags(id)[kind]].sort()
      const missing = flags.filter((flag) => !mentions(result.output, flag))
      return missing.length === 0
        ? { ok: true, detail: `${flags.length} flags found in \`${[bin.split('/').pop(), ...helpArgs].join(' ')}\`: ${flags.join(' ')}` }
        : { ok: false, detail: `not in \`${[bin.split('/').pop(), ...helpArgs].join(' ')}\`: ${missing.join(' ')}` }
    },
  }
}

for (const id of agentIds) checks.push(flagCheck(id, 'turn'), flagCheck(id, 'attach'))

// The auth-status commands src/core/detect.ts runs on `konvoy status`. Running each is the
// check: exit 127 means no binary, and a CLI that has dropped the subcommand says so in its
// own words. Logged in or not, the subcommand existing is what konvoy depends on.
const AUTH_ARGS: Record<AgentId, string[]> = { claude: ['auth', 'status'], codex: ['login', 'status'], kiro: ['whoami'], opencode: ['auth', 'list'] }
const UNKNOWN_SUBCOMMAND = /unrecognized subcommand|unknown (?:sub)?command|invalid (?:sub)?command|no such (?:sub)?command|is not a .*command|command not found/i

function authCheck(id: AgentId): Check {
  return {
    label: `${id} auth-status subcommand exists (${AUTH_ARGS[id].join(' ')})`,
    run: async () => {
      const bin = await resolveBin(BIN_CANDIDATES[AGENT_KEY[id]])
      if (!bin) return { ok: false, detail: `${id} not found on this machine — cannot verify` }
      const result = await run([bin, ...AUTH_ARGS[id]])
      if (!result) return { ok: false, detail: `${bin} ${AUTH_ARGS[id].join(' ')} failed to spawn` }
      if (result.exitCode === 127) return { ok: false, detail: 'exit 127' }
      if (UNKNOWN_SUBCOMMAND.test(result.output)) return { ok: false, detail: `rejected: ${firstLine(result.output)}` }
      return { ok: true, detail: `exit ${result.exitCode}: ${firstLine(result.output).slice(0, 60)}` }
    },
  }
}

for (const id of agentIds) checks.push(authCheck(id))

let staleCount = 0
console.log("verify:claims — checking konvoy's documented CLI claims against what's installed here\n")
for (const check of checks) {
  const { ok, detail } = await check.run()
  if (!ok) staleCount++
  console.log(`[${ok ? 'ok   ' : 'stale'}] ${check.label} — ${detail}`)
}

console.log(`\n${checks.length - staleCount} ok, ${staleCount} stale`)
process.exit(staleCount > 0 ? 1 : 0)
