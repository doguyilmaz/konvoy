// Bun's test runner resolves JS to UTC when TZ is unset, while bun:sqlite's 'localtime'
// modifier reads the OS zone regardless. Left alone the two disagree and the day-bucketing
// tests fail on a bare `bun test` while passing under `TZ=... bun test` — a suite that is red
// by default teaches people to ignore it. Pinning the zone makes both agree.
//
// Europe/Istanbul is fixed at +03 with no daylight saving, so it cannot make the suite break
// twice a year, and being off UTC is what lets the local-day tests discriminate at all.
process.env.TZ = 'Europe/Istanbul'
