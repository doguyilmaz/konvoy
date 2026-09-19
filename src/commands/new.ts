import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { newSession } from '../core/session'
import { sessionDir } from '../paths'

export async function cmdNew(db: Database, cfg: Config, cwd: string, goal: string): Promise<number> {
  const lead = cfg.roles.lead ?? 'claude'
  const session = newSession(db, { cwd, goal: goal || 'untitled', lead })
  const dir = sessionDir(cwd, session.slug)
  await Bun.write(`${dir}/CONTEXT.md`, `# ${session.slug}\n\n## Goal\n\n${session.goal}\n`)
  await Bun.write(`${dir}/LEDGER.md`, `# Ledger — ${session.slug}\n`)
  console.log(`created session ${session.slug} (lead: ${lead})`)
  console.log(dir)
  return 0
}
