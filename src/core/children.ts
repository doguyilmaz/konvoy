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
          handler(signal)
        } catch {
          // a cleanup that fails must not stop the others from running
        }
      }
      exitHandlers.clear()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

type ExitHandler = (signal: 'SIGINT' | 'SIGTERM') => void

const exitHandlers = new Set<ExitHandler>()

export function onExit(fn: ExitHandler): () => void {
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

// Bun's own `timeout` sends killSignal once and never follows up - a child that traps or
// ignores SIGTERM then hangs forever. SIGKILL cannot be trapped; it goes out once the timeout
// has had a grace period to work. Every bounded spawn (a turn, a gate) uses this one.
export const DEFAULT_KILL_GRACE_MS = 2_000

export function escalateKill(proc: { exitCode: number | null; kill(signal: 'SIGKILL'): void }, afterMs: number): () => void {
  const timer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL')
  }, afterMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
