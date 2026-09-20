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
process.exit(exitCode)
