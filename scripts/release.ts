// bun run scripts/release.ts build [--only darwin|linux]   — compile every target into dist/release/<os>_<arch>/konvoy
// bun run scripts/release.ts pack                          — tar each built binary with LICENSE and README, write checksums
//
// Split in two so the macOS runner can sign and notarize the darwin binaries between the steps.
// The build recipe is the one measured on 2026-09-21: esm bytecode for a 10 ms start, sourcemaps
// for readable stack traces, and no .env or bunfig autoload from the directory konvoy runs in —
// konvoy runs inside other people's repositories and hands its environment to the agents.
import pkg from '../package.json'

interface Target {
  target: 'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-x64' | 'bun-linux-arm64'
  os: 'darwin' | 'linux'
  arch: 'arm64' | 'amd64'
}

// GoReleaser's naming, which the tap's other casks already use: amd64, not x64
export const TARGETS: readonly Target[] = [
  { target: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64' },
  { target: 'bun-darwin-x64', os: 'darwin', arch: 'amd64' },
  { target: 'bun-linux-x64', os: 'linux', arch: 'amd64' },
  { target: 'bun-linux-arm64', os: 'linux', arch: 'arm64' },
]

const OUT = 'dist/release'
const dirFor = (t: Target): string => `${OUT}/${t.os}_${t.arch}`
export const assetName = (t: Target): string => `konvoy_${t.os}_${t.arch}.tar.gz`

async function build(only?: string): Promise<void> {
  const chosen = TARGETS.filter((t) => !only || t.os === only)
  if (chosen.length === 0) throw new Error(`no targets match --only ${only}`)
  for (const t of chosen) {
    const outfile = `${dirFor(t)}/konvoy`
    const result = await Bun.build({
      entrypoints: ['./src/cli.ts'],
      compile: { target: t.target, outfile, autoloadDotenv: false, autoloadBunfig: false },
      format: 'esm',
      minify: true,
      sourcemap: 'linked',
      bytecode: true,
    })
    if (!result.success) throw new Error(`${t.target}: ${result.logs.map((l) => l.message).join('; ')}`)
    console.log(`built ${outfile} (${t.target})`)
  }
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

async function pack(): Promise<void> {
  const lines: string[] = []
  for (const t of TARGETS) {
    const dir = dirFor(t)
    if (!(await Bun.file(`${dir}/konvoy`).exists())) continue
    await Bun.write(`${dir}/LICENSE`, Bun.file('LICENSE'))
    await Bun.write(`${dir}/README.md`, Bun.file('README.md'))
    const asset = `${OUT}/${assetName(t)}`
    const tar = Bun.spawn(['tar', 'czf', asset, '-C', dir, 'konvoy', 'LICENSE', 'README.md'], { stdout: 'inherit', stderr: 'inherit' })
    if ((await tar.exited) !== 0) throw new Error(`tar failed for ${asset}`)
    lines.push(`${await sha256(asset)}  ${assetName(t)}`)
    console.log(`packed ${asset}`)
  }
  if (lines.length === 0) throw new Error('nothing built to pack — run build first')
  // one file per OS so the two runners' outputs merge into checksums.txt without a collision
  const os = new Set(lines.map((l) => l.split('_')[1]))
  const suffix = os.size === 1 ? [...os][0] : 'all'
  await Bun.write(`${OUT}/checksums-${suffix}.txt`, lines.join('\n') + '\n')
  console.log(`wrote ${OUT}/checksums-${suffix}.txt`)
}

function requireVersionMatch(): void {
  const tag = Bun.env.GITHUB_REF_NAME
  if (Bun.env.GITHUB_REF_TYPE === 'tag' && tag && tag.replace(/^v/, '') !== pkg.version) {
    throw new Error(`tag ${tag} does not match package.json version ${pkg.version}`)
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2)
  requireVersionMatch()
  if (cmd === 'build') await build(rest[0] === '--only' ? rest[1] : undefined)
  else if (cmd === 'pack') await pack()
  else {
    console.error('usage: bun run scripts/release.ts build [--only darwin|linux] | pack')
    process.exit(2)
  }
}
