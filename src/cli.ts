const VERSION = '0.1.0'

export async function main(argv: string[]): Promise<number> {
  const [command] = argv
  if (command === '--version' || command === 'version') {
    console.log(`konvoy ${VERSION}`)
    return 0
  }
  console.error('usage: konvoy <command>')
  return 1
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
