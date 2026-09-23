// bun test runs in UTC unless TZ is set; the local-day tests need a zone off UTC to discriminate.
// Europe/Istanbul has no daylight saving.
process.env.TZ = 'Europe/Istanbul'

// A test file sees `process.stdout.isTTY === true` when the suite is run in a terminal and false
// when it is piped, so every command that colours its output produced different bytes depending on
// how `bun test` was launched: the suite was green piped and failed seven tests under a real
// terminal. NO_COLOR is the standard konvoy already honours (src/style.ts), so the test
// environment declares it once rather than each test guessing. Colour itself stays tested where it
// belongs, by passing `color: true` explicitly - see tests/table.test.ts and tests/style.color.test.ts.
process.env.NO_COLOR = '1'

