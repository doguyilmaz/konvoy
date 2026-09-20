import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { Session } from '../types'
import { setGateResult, turnExitCode } from '../store/queries'
import { DEFAULT_KILL_GRACE_MS, escalateKill } from './children'

// A quality check the user chose to run — konvoy has no model of its own, so it never
// grades the work itself. Bounded so a hung suite can't block konvoy forever.
const GATE_TIMEOUT_MS = 5 * 60 * 1000

export async function runGate(
  db: Database,
  cfg: Config,
  session: Session,
  turnId: string,
  opts: { timeoutMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  const command = cfg.gate.command
  if (!command) return
  // A turn with nothing for the gate to judge — running it now would blame the block on the work.
  if (turnExitCode(db, turnId) !== 0) return

  const cmd = command.split(/\s+/).filter(Boolean)

  try {
    const proc = Bun.spawn(cmd, {
      cwd: session.cwd,
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: opts.timeoutMs ?? GATE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    const cancelEscalation = escalateKill(proc, (opts.timeoutMs ?? GATE_TIMEOUT_MS) + (opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS))
    try {
      const exitCode = await proc.exited
      setGateResult(db, turnId, exitCode === 0)
    } finally {
      cancelEscalation()
    }
  } catch {
    // could not spawn: a misconfiguration, not a verdict on the work, so nothing is recorded
  }
}
