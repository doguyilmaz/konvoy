export interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const name = token.replace(/^--?/, '')
    if (name.includes('=')) {
      const [key, ...rest] = name.split('=')
      flags[key!] = rest.join('=')
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }

  return { _: positional, flags }
}
