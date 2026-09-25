#!/usr/bin/env bun
// A stand-in claude for tests that need a real process: it answers with the prompt it was given
// (the argument after `--`), in claude's own stream-json shape.
const args = Bun.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.282 (Claude Code)')
  process.exit(0)
}
const asked = args[args.indexOf('--') + 1] ?? ''
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-00000000abcd' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: asked, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }))
