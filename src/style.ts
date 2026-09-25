import type { AgentId } from './types'

export type Paint = (text: string) => string

export interface Palette {
  bold: Paint
  dim: Paint
  italic: Paint
  underline: Paint
  inverse: Paint
  red: Paint
  green: Paint
  yellow: Paint
  blue: Paint
  magenta: Paint
  cyan: Paint
  gray: Paint
}

/** 0 no colour, 1 the sixteen ANSI colours, 2 the xterm 256 cube, 3 24-bit */
export type ColorLevel = 0 | 1 | 2 | 3

// Every style closes with its own code rather than a blanket reset. `\x1b[0m` inside a painted
// span ended the OUTER style too: a green ✓ inside a dim tool line un-dimmed everything after it.
const CODES: Record<keyof Palette, readonly [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
}

const identity: Paint = (text) => text

// A nested span that closes with the same code as its parent (bold inside dim both end on 22)
// would end the parent early, so every close inside the text re-opens the outer style after it.
function wrap(open: string, close: string): Paint {
  return (text) => `${open}${text.replaceAll(close, close + open)}${close}`
}

// NO_COLOR is honoured for any value that is set and not empty (no-color.org), and it outranks
// FORCE_COLOR: a user who turned colour off did so deliberately, a tool that turned it on did
// not know about them. FORCE_COLOR exists so a pipe can still be coloured - a demo, a CI log.
export function colorEnabled(env: Record<string, string | undefined>, tty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return true
  if (env.TERM === 'dumb') return false
  return tty
}

// How many colours the terminal takes, read from the same variables every other CLI reads:
// COLORTERM is the one terminals set for 24-bit, FORCE_COLOR=2|3 is Node's convention for asking
// for a depth, and a handful of terminals that support 24-bit are known by name when they do not
// export COLORTERM (VS Code's integrated terminal is the common one).
export function colorLevel(env: Record<string, string | undefined>, tty: boolean): ColorLevel {
  if (!colorEnabled(env, tty)) return 0
  if (env.FORCE_COLOR === '3') return 3
  if (env.FORCE_COLOR === '2') return 2
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3
  if (TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? '') || env.WT_SESSION) return 3
  const term = env.TERM ?? ''
  if (/kitty|alacritty|ghostty|wezterm|direct/.test(term)) return 3
  if (/256/.test(term)) return 2
  return 1
}

const TRUECOLOR_PROGRAMS = new Set(['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby', 'rio'])

const toLevel = (on: boolean | ColorLevel): ColorLevel => (on === true ? 1 : on === false ? 0 : on)

export function palette(on: boolean | ColorLevel): Palette {
  const level = toLevel(on)
  const out = {} as Palette
  for (const name of Object.keys(CODES) as (keyof Palette)[]) {
    const [open, close] = CODES[name]
    out[name] = level > 0 ? wrap(`\x1b[${open}m`, `\x1b[${close}m`) : identity
  }
  return out
}

// The nearest entry of the xterm 256-colour cube, for a terminal that has the cube but not 24-bit.
function to256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const q = (v: number): number => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

/** a foreground colour from a hex value, degraded to what the terminal can show */
export function hex(color: string, level: boolean | ColorLevel, fallback: keyof Palette): Paint {
  const l = toLevel(level)
  if (l === 0) return identity
  if (l === 1) return palette(1)[fallback]
  const n = Number.parseInt(color.replace('#', ''), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const open = l === 3 ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${to256(r, g, b)}m`
  return wrap(open, '\x1b[39m')
}

// One colour per agent, held everywhere konvoy names one: a transcript that alternates agents
// is unreadable when every name is the same white word. Each is the colour its own CLI wears where
// that is known - claude's terracotta (rgb(215,119,87) in Claude Code's theme), codex's UI accent
// (codex-rs/tui style.rs), kiro's dark-theme brand purple, opencode's default-theme primary.
// Antigravity publishes no brand hex and its bright-blue prompt would read as codex, so it takes
// Google's green. The sixteen-colour fallbacks follow the same hues and only need to differ.
export const AGENT_COLOR: Record<AgentId, { hex: string; basic: keyof Palette }> = {
  claude: { hex: '#D77757', basic: 'red' },
  codex: { hex: '#63A8F8', basic: 'blue' },
  kiro: { hex: '#C19AFF', basic: 'magenta' },
  opencode: { hex: '#FAB283', basic: 'yellow' },
  antigravity: { hex: '#34A853', basic: 'green' },
}

export function agentPaint(on: boolean | ColorLevel): (agent: string) => Paint {
  const level = toLevel(on)
  const bold = palette(level).bold
  const painted = new Map<string, Paint>()
  for (const [agent, color] of Object.entries(AGENT_COLOR)) painted.set(agent, hex(color.hex, level, color.basic))
  return (agent) => painted.get(agent) ?? bold
}
