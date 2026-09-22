import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import { newSession, slugify } from '../core/session'
import { basename, join, sessionDir } from '../paths'

export async function cmdNew(db: Database, cfg: Config, cwd: string, goal: string): Promise<number> {
  const lead = cfg.roles.lead ?? 'claude'
  const suffix = Bun.randomUUIDv7().slice(-4)
  const slug = goal ? undefined : `${slugify(basename(cwd)).slice(0, 30)}-${suffix}`
  const session = newSession(db, { cwd, goal, lead, slug })
  const dir = sessionDir(cwd, session.slug)
  const ignore = Bun.file(join(cwd, '.konvoy', '.gitignore'))
  if (!(await ignore.exists())) await Bun.write(ignore, '*\n!config.jsonc\n')
  // `konvoy rm` frees the slug but leaves these files - they are the user's. A new session under
  // an old slug adds its goal to the context and appends to the ledger; it truncates neither.
  const context = Bun.file(`${dir}/CONTEXT.md`)
  const goalSection = session.goal ? `\n## Goal\n\n${session.goal}\n` : ''
  await Bun.write(
    context,
    (await context.exists()) ? `${await context.text()}${goalSection}` : `# ${session.slug}\n${goalSection}`,
  )
  const ledger = Bun.file(`${dir}/LEDGER.md`)
  if (!(await ledger.exists())) await Bun.write(ledger, `# Ledger - ${session.slug}\n`)
  console.log(`created session ${session.slug} (lead: ${lead})`)
  console.log(dir)
  return 0
}
