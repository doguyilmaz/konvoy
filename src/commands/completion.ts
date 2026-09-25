import { agentIds } from '../config/schema'
import { commandTable, GLOBAL_FLAGS } from './table'

// Shell completion generated from the command table, so it cannot drift from what konvoy accepts:
// the commands and their flags, the agents after the commands that take one, and the live session
// slugs after the ones that take a session - read back from konvoy itself through `__complete`.

const SESSION_COMMANDS = ['resume', 'rm', 'rename']
const AGENT_COMMANDS = ['send', 'attach']
// these take any number of agents, so every position after the command offers one
const MULTI_AGENT_COMMANDS = ['install', 'update', 'upgrade']

const words = (xs: readonly string[]): string => xs.join(' ')
const longFlags = (flags: readonly string[]): string[] => flags.filter((f) => f.length > 1).map((f) => `--${f}`)
const globals = longFlags(GLOBAL_FLAGS.filter((f) => f === 'session' || f === 'help'))

function bash(): string {
  const names = commandTable.flatMap((c) => [c.name, ...c.aliases])
  const flagCases = commandTable
    .filter((c) => c.flags.length > 0)
    .map((c) => `    ${[c.name, ...c.aliases].join('|')}) flags="${words(longFlags(c.flags))} $flags" ;;`)
    .join('\n')
  return `# konvoy bash completion: eval "$(konvoy completion bash)"
_konvoy() {
  local cur prev cmd flags
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  case "$prev" in
    --session) COMPREPLY=($(compgen -W "$(konvoy __complete sessions 2>/dev/null)" -- "$cur")); return ;;
    --lead) COMPREPLY=($(compgen -W "${words(agentIds)}" -- "$cur")); return ;;
    --via) COMPREPLY=($(compgen -W "script npm brew bun" -- "$cur")); return ;;
  esac
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${words(names)} ${words(globals)} --version" -- "$cur"))
    return
  fi
  flags="${words(globals)}"
  case "$cmd" in
${flagCases}
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
    return
  fi
  case "$cmd" in
    ${MULTI_AGENT_COMMANDS.join("|")}) COMPREPLY=($(compgen -W "${words(agentIds)}" -- "$cur")); return ;;
  esac
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$cmd" in
      ${AGENT_COMMANDS.join('|')}) COMPREPLY=($(compgen -W "${words(agentIds)}" -- "$cur")) ;;
      ${SESSION_COMMANDS.join('|')}) COMPREPLY=($(compgen -W "$(konvoy __complete sessions 2>/dev/null)" -- "$cur")) ;;
      config) COMPREPLY=($(compgen -W "get set unset path" -- "$cur")) ;;
      completion) COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")) ;;
    esac
  fi
}
complete -F _konvoy konvoy
`
}

// zsh quotes with single quotes; a quote inside one is closed, escaped and reopened
const zq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

function zsh(): string {
  const described = commandTable
    .flatMap((c) => [c.name, ...c.aliases].map((n) => zq(`${n}:${c.summary.replace(/:/g, '\\:')}`)))
    .join('\n    ')
  const flagCases = commandTable
    .filter((c) => c.flags.length > 0)
    .map((c) => `    ${[c.name, ...c.aliases].join('|')}) flags+=(${longFlags(c.flags).join(' ')}) ;;`)
    .join('\n')
  return `#compdef konvoy
# konvoy zsh completion: source <(konvoy completion zsh)
_konvoy() {
  local -a commands flags
  commands=(
    ${described}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case $words[CURRENT-1] in
    --session) compadd -- \${(f)"$(konvoy __complete sessions 2>/dev/null)"}; return ;;
    --lead) compadd -- ${words(agentIds)}; return ;;
    --via) compadd -- script npm brew bun; return ;;
  esac
  flags=(${words(globals)})
  case $words[2] in
${flagCases}
  esac
  if [[ $PREFIX == -* ]]; then
    compadd -- $flags
    return
  fi
  case $words[2] in
    ${MULTI_AGENT_COMMANDS.join('|')}) compadd -- ${words(agentIds)}; return ;;
  esac
  if (( CURRENT == 3 )); then
    case $words[2] in
      ${AGENT_COMMANDS.join('|')}) compadd -- ${words(agentIds)} ;;
      ${SESSION_COMMANDS.join('|')}) compadd -- \${(f)"$(konvoy __complete sessions 2>/dev/null)"} ;;
      config) compadd -- get set unset path ;;
      completion) compadd -- bash zsh fish ;;
    esac
  fi
}
if (( $+functions[compdef] )); then compdef _konvoy konvoy; fi
`
}

const fq = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

function fish(): string {
  const lines = [
    '# konvoy fish completion: konvoy completion fish | source',
    'complete -c konvoy -f',
    `complete -c konvoy -l session -x -a '(konvoy __complete sessions 2>/dev/null)' -d 'the session to act on'`,
    `complete -c konvoy -l help -d 'show help'`,
  ]
  for (const c of commandTable) {
    for (const n of [c.name, ...c.aliases]) lines.push(`complete -c konvoy -n __fish_use_subcommand -a ${n} -d ${fq(c.summary)}`)
    for (const f of c.flags) {
      const value = ['lead', 'limit', 'port', 'id', 'via'].includes(f) ? ' -x' : ''
      const agents = f === 'lead' ? ` -a ${fq(words(agentIds))}` : f === 'via' ? ` -a 'script npm brew bun'` : ''
      lines.push(`complete -c konvoy -n '__fish_seen_subcommand_from ${[c.name, ...c.aliases].join(' ')}' -l ${f}${value}${agents}`)
    }
  }
  lines.push(`complete -c konvoy -n '__fish_seen_subcommand_from ${[...AGENT_COMMANDS, ...MULTI_AGENT_COMMANDS].join(' ')}' -a ${fq(words(agentIds))}`)
  lines.push(`complete -c konvoy -n '__fish_seen_subcommand_from ${SESSION_COMMANDS.join(' ')}' -a '(konvoy __complete sessions 2>/dev/null)'`)
  lines.push(`complete -c konvoy -n '__fish_seen_subcommand_from config' -a 'get set unset path'`)
  lines.push(`complete -c konvoy -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'`)
  return `${lines.join('\n')}\n`
}

export const completionScripts = { bash, zsh, fish } as const

export function cmdCompletion(shell: string | undefined): number {
  const make = shell ? completionScripts[shell as keyof typeof completionScripts] : undefined
  if (!make) {
    console.error('usage: konvoy completion bash|zsh|fish')
    return 2
  }
  process.stdout.write(make())
  return 0
}
