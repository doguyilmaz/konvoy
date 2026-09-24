export function join(...parts: string[]): string {
  const absolute = parts[0]?.startsWith('/') ?? false
  const segments: string[] = []
  for (const part of parts) {
    for (const segment of part.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        segments.pop()
        continue
      }
      segments.push(segment)
    }
  }
  return (absolute ? '/' : '') + segments.join('/')
}

export const basename = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? ''

export function dirname(p: string): string {
  const cut = p.lastIndexOf('/')
  if (cut < 0) return '.'
  if (cut === 0) return '/'
  return p.slice(0, cut)
}

export function home(): string {
  const h = Bun.env.HOME
  if (!h) throw new Error('HOME is not set')
  return h
}

export const configDir = (): string => join(home(), '.config', 'konvoy')
const dataDir = (): string => join(home(), '.local', 'share', 'konvoy')
export const dbPath = (): string => join(dataDir(), 'konvoy.db')
export const historyPath = (): string => join(dataDir(), 'history.jsonl')
export const sessionDir = (cwd: string, slug: string): string => join(cwd, '.konvoy', slug)
