export {}
// An agent that answers, leaves a background process holding its stdout, and exits — the shape
// of an agent that started a dev server or a watcher. konvoy's turn must end on its own clock.
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'leaky' }) + '\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n')
Bun.spawn(['sleep', '3'], { stdout: 'inherit', stderr: 'inherit' })
await Bun.sleep(50)
process.exit(0)