// Mutation sweep runner - `bun run mutate`. For every entry in registry.ts: verify the
// defect's `from` text still appears exactly once in the real source, apply it, run only the
// tests that claim to catch it, record CAUGHT or MISSED, and restore the file byte-for-byte
// before moving to the next entry. See registry.ts for why this exists.
import { mutations, type Mutation } from './registry'

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

function run(cmd: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() }
}

function assertCleanTree(): void {
  // Only src/ is touched by the sweep - that is the "source" the brief's rationale is about -
  // so a dirty tests/ file (e.g. while demonstrating this very runner) does not block a run.
  const status = run(['git', 'status', '--porcelain', '--', 'src'])
  if (status.out.trim() !== '') {
    console.error('mutate: refusing to start - src/ has uncommitted changes:')
    console.error(status.out)
    process.exit(1)
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = 0
  for (;;) {
    const i = haystack.indexOf(needle, at)
    if (i === -1) break
    count++
    at = i + needle.length
  }
  return count
}

function extractFailingTests(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.+?) \[/gm)].map((m) => m[1]!)
}

type Verdict =
  | { status: 'BROKEN'; reason: string }
  | { status: 'CAUGHT'; failingTests: string[] }
  | { status: 'MISSED' }

async function evaluate(m: Mutation, pristine: Map<string, string>): Promise<Verdict> {
  const path = `${repoRoot}/${m.file}`
  let original = pristine.get(path)
  if (original === undefined) {
    original = await Bun.file(path).text()
    pristine.set(path, original)
  }

  const occurrences = countOccurrences(original, m.from)
  if (occurrences !== 1) {
    return { status: 'BROKEN', reason: `"from" appears ${occurrences} time(s) in ${m.file}, expected exactly 1` }
  }

  const mutated = original.replace(m.from, m.to)
  await Bun.write(path, mutated)

  try {
    const result = run(['bun', 'test', ...m.tests])
    if (result.code !== 0) {
      return { status: 'CAUGHT', failingTests: extractFailingTests(result.out) }
    }
    return { status: 'MISSED' }
  } finally {
    await Bun.write(path, original)
  }
}

async function main(): Promise<void> {
  assertCleanTree()

  const pristine = new Map<string, string>()
  const broken: { m: Mutation; reason: string }[] = []
  const missed: Mutation[] = []
  const caught: { m: Mutation; failingTests: string[] }[] = []

  for (const m of mutations) {
    const verdict = await evaluate(m, pristine)
    if (verdict.status === 'BROKEN') {
      broken.push({ m, reason: verdict.reason })
      console.log(`BROKEN  ${m.name}`)
      console.log(`        ${verdict.reason}`)
    } else if (verdict.status === 'MISSED') {
      missed.push(m)
      console.log(`MISSED  ${m.name}  (${m.file}, expected to fail: ${m.tests.join(', ')})`)
    } else {
      caught.push({ m, failingTests: verdict.failingTests })
      const names = verdict.failingTests.length > 0 ? verdict.failingTests.join('; ') : m.tests.join(', ')
      console.log(`CAUGHT  ${m.name}`)
      console.log(`        failed: ${names}`)
    }
  }

  console.log('')
  console.log('verifying every touched file was restored byte-identical...')
  let corrupted = 0
  for (const [path, original] of pristine) {
    const now = await Bun.file(path).text()
    if (now !== original) {
      corrupted++
      console.error(`INTEGRITY FAILURE: ${path} does not match its pre-sweep content`)
    }
  }
  if (corrupted === 0) console.log(`ok - ${pristine.size} file(s) byte-identical to their pre-sweep content`)

  console.log('')
  console.log('running the full suite...')
  const full = run(['bun', 'test'])
  console.log(full.out.trim().split('\n').slice(-4).join('\n'))
  const suiteGreen = full.code === 0
  // Name the casualties. The summary alone says "1 fail" and nothing else, which is how a flake
  // in this step once went untraceable: by the time anyone looked, the run was green again.
  if (!suiteGreen) {
    for (const name of extractFailingTests(full.out)) console.log(`  casualty: ${name}`)
  }

  console.log('')
  console.log(
    `summary: ${caught.length} caught, ${missed.length} missed, ${broken.length} broken, ${mutations.length} total`,
  )

  if (missed.length > 0 || broken.length > 0 || corrupted > 0 || !suiteGreen) {
    if (!suiteGreen) console.error('the full suite is not green after the sweep')
    process.exit(1)
  }
}

await main()
