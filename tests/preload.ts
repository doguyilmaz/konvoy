// bun test runs in UTC unless TZ is set; the local-day tests need a zone off UTC to discriminate.
// Europe/Istanbul has no daylight saving.
process.env.TZ = 'Europe/Istanbul'
