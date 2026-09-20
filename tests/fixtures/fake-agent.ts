export {}

const args = Bun.argv.slice(2)
const delayMs = Number(Bun.env.FAKE_AGENT_DELAY_MS ?? '0')
const exitCode = Number(Bun.env.FAKE_AGENT_EXIT ?? '0')

if (Bun.env.FAKE_AGENT_TRAP_SIGTERM === '1') {
  process.on('SIGTERM', () => {})
}

for (const line of args) {
  if (delayMs > 0) await Bun.sleep(delayMs)
  process.stdout.write(line + '\n')
}
// A CLI that dies before it can emit a single stream event reports only on stderr — the shape
// kiro uses for a session id it cannot load, which no stdout-only fake could reproduce.
if (Bun.env.FAKE_AGENT_STDERR) process.stderr.write(Bun.env.FAKE_AGENT_STDERR + '\n')
process.exit(exitCode)
