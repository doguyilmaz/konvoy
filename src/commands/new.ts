import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { newSession } from '../core/session'
import { sessionDir } from '../paths'

export async function cmdNew(db: Database, cfg: Config, cwd: string, goal: string): Promise<number> {
  const lead = cfg.roles.lead ?? 'claude'
  const session = newSession(db, { cwd, goal: goal || 'untitled', lead })
  const dir = sessionDir(cwd, session.slug)
  // `konvoy rm` frees the slug but leaves these files — they are the user's. A new session under
  // an old slug adds its goal to the context and appends to the ledger; it truncates neither.
  const context = Bun.file(`${dir}/CONTEXT.md`)
  await Bun.write(
    context,
    (await context.exists())
      ? `${await context.text()}\n## Goal\n\n${session.goal}\n`
      : `# ${session.slug}\n\n## Goal\n\n${session.goal}\n`,
  )
  const ledger = Bun.file(`${dir}/LEDGER.md`)
  if (!(await ledger.exists())) await Bun.write(ledger, `# Ledger — ${session.slug}\n`)
  console.log(`created session ${session.slug} (lead: ${lead})`)
  console.log(dir)
  return 0
}
