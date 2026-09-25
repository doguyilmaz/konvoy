import type { Database } from 'bun:sqlite'
import { currentSession, getSessionBySlug } from '../store/queries'
import type { Config } from '../config/schema'
import { collect, renderPage } from '../dashboard/page'

export async function cmdDashboard(
  db: Database,
  cfg: Config,
  cwd: string,
  opts: { port?: number; slug?: string; open?: boolean },
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
  const url = `http://127.0.0.1:${server.port}`
  console.log(`konvoy dashboard on ${url} - ctrl-c to stop`)
  // opened for a person at a terminal; a script asked for a server, not a browser window
  if (opts.open !== false && process.stdout.isTTY) openInBrowser(url)
  await new Promise(() => {})
  return 0
}

// the platform's own opener, quietly: a headless box or an SSH session has none, and the URL above
// is still the whole of what the command promised
function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const bin = Bun.which(opener)
  if (!bin) return
  try {
    Bun.spawn([bin, url], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref()
  } catch {
    // no browser to hand it to
  }
}
