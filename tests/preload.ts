// bun test runs in UTC unless TZ is set, and a zone on UTC cannot tell local-day bucketing from
// UTC bucketing. Europe/Istanbul is fixed at +03 with no daylight saving, so the pin cannot break
// the suite twice a year. Day bucketing happens in JS, which is what this pin reaches.
process.env.TZ = 'Europe/Istanbul'
