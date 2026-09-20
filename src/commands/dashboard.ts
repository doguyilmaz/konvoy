import type { Database } from 'bun:sqlite'
import { currentSession, getSessionBySlug } from '../store/queries'
import type { Config } from '../config/schema'
import { collect, renderPage } from '../dashboard/page'

export async function cmdDashboard(
  db: Database,
  cfg: Config,
  cwd: string,
  opts: { port?: number; slug?: string },
): Promise<number> {
  const session = opts.slug ? getSessionBySlug(db, opts.slug) : currentSession(db, cwd)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    fetch: () => {
      const data = collect(db, cfg, session?.id)
      return new Response(renderPage({ ...data, title: session?.slug ?? 'all sessions' }), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
  console.log(`konvoy dashboard on http://127.0.0.1:${server.port} — ctrl-c to stop`)
  await new Promise(() => {})
  return 0
}
