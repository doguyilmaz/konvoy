import type { Database } from 'bun:sqlite'
import type { Config } from '../config/schema'
import type { Session } from '../types'
import { setGateResult, turnExitCode } from '../store/queries'

// A quality check the user chose to run — konvoy has no model of its own, so it never
// grades the work itself. Bounded so a hung suite can't block konvoy forever.
const GATE_TIMEOUT_MS = 5 * 60 * 1000

export async function runGate(db: Database, cfg: Config, session: Session, turnId: string): Promise<void> {
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
      timeout: GATE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    const exitCode = await proc.exited
    setGateResult(db, turnId, exitCode === 0)
  } catch {
    // could not spawn: a misconfiguration, not a verdict on the work, so nothing is recorded
  }
}
