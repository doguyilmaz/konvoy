import { openDb } from '../../src/store/db'

try {
  openDb(Bun.argv[2]!)
  console.log('OK')
} catch (error) {
  console.log(`THROW: ${String(error).slice(-100)}`)
}
