import type { Database } from 'bun:sqlite'
import { slugify } from '../core/session'
import { sessionDir } from '../paths'
import { getSessionBySlug, lockOwner, renameSession } from '../store/queries'
import { requireNamedSession } from './messages'

const isDir = async (path: string): Promise<boolean> => (await Bun.$`test -d ${path}`.quiet().nothrow()).exitCode === 0

async function retitle(path: string, from: string, to: string): Promise<void> {
  const file = Bun.file(path)
  if (!(await file.exists())) return
  const text = await file.text()
  if (text.startsWith(from)) await Bun.write(file, to + text.slice(from.length))
}

export async function cmdRename(db: Database, from: string, to: string): Promise<number> {
  const session = requireNamedSession(db, from)
  if (!session) return 2
  const busy = lockOwner(db, session.id)
  if (busy) {
    console.error(`"${from}" has a turn running (${busy}) - wait for it to finish, then retry`)
    return 2
  }
  const slug = slugify(to)
  if (getSessionBySlug(db, slug)) {
    console.error(`a session named "${slug}" already exists`)
    return 2
  }
  const oldDir = sessionDir(session.cwd, from)
  const newDir = sessionDir(session.cwd, slug)
  if (await isDir(oldDir)) {
    if (await isDir(newDir)) {
      console.error(`${newDir} already exists - move it away first`)
      return 2
    }
    const moved = await Bun.$`mv ${oldDir} ${newDir}`.quiet().nothrow()
    if (moved.exitCode !== 0) {
      console.error(`could not move ${oldDir} to ${newDir}: ${moved.stderr.toString().trim()}`)
      return 1
    }
    await retitle(`${newDir}/CONTEXT.md`, `# ${from}\n`, `# ${slug}\n`)
    await retitle(`${newDir}/LEDGER.md`, `# Ledger - ${from}\n`, `# Ledger - ${slug}\n`)
  }
  renameSession(db, session.id, slug)
  console.log(`renamed ${from} -> ${slug}`)
  return 0
}
