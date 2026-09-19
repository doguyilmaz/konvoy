type Child = { kill(): void; exitCode: number | null }

const live = new Set<Child>()
let installed = false

function install(): void {
  if (installed) return
  installed = true
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      for (const child of live) {
        if (child.exitCode === null) child.kill()
      }
      live.clear()
      for (const handler of exitHandlers) {
        try {
          handler()
        } catch {
          // a cleanup that fails must not stop the others from running
        }
      }
      exitHandlers.clear()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

const exitHandlers = new Set<() => void>()

export function onExit(fn: () => void): () => void {
  install()
  exitHandlers.add(fn)
  return () => exitHandlers.delete(fn)
}

export function track(child: Child): void {
  install()
  live.add(child)
}

export function untrack(child: Child): void {
  live.delete(child)
}

export function liveCount(): number {
  return live.size
}
