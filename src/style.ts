import type { AgentId } from './types'

export type Paint = (text: string) => string

export interface Palette {
  bold: Paint
  dim: Paint
  red: Paint
  green: Paint
  yellow: Paint
  blue: Paint
  magenta: Paint
  cyan: Paint
}

const CODES: Record<keyof Palette, string> = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
}

const identity: Paint = (text) => text

// NO_COLOR is honoured for any value that is set and not empty (no-color.org), and it outranks
// FORCE_COLOR: a user who turned colour off did so deliberately, a tool that turned it on did
// not know about them. FORCE_COLOR exists so a pipe can still be coloured - a demo, a CI log.
export function colorEnabled(env: Record<string, string | undefined>, tty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return true
  if (env.TERM === 'dumb') return false
  return tty
}

export function palette(on: boolean): Palette {
  const out = {} as Palette
  for (const name of Object.keys(CODES) as (keyof Palette)[]) {
    const code = CODES[name]
    out[name] = on ? (text) => `\x1b[${code}m${text}\x1b[0m` : identity
  }
  return out
}

// One colour per agent, held everywhere konvoy names one: a transcript that alternates agents
// is unreadable when every name is the same white word.
const AGENT_COLOR: Record<AgentId, keyof Palette> = {
  claude: 'cyan',
  codex: 'green',
  kiro: 'magenta',
  opencode: 'yellow',
}

export function agentPaint(on: boolean): (agent: string) => Paint {
  const p = palette(on)
  return (agent) => p[AGENT_COLOR[agent as AgentId] ?? 'bold'] ?? identity
}
