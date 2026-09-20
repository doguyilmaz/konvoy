import type { Database } from 'bun:sqlite'
import type { Session } from '../types'
import { usageForSession } from '../store/queries'
import { spend } from '../format'

export interface Facts {
  commits: { sha: string; subject: string }[]
  files: { path: string; added: number; removed: number }[]
  agents: { agent: string; turns: number; spend: string }[]
}

export interface FactsDeps {
  git: (args: string[], cwd: string) => Promise<string>
}

function parseLog(output: string): { sha: string; subject: string }[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(' ')
      return sp === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, sp), subject: line.slice(sp + 1) }
    })
}

const STAT_LINE = /^\s*(.+?)\s*\|\s*(\d+)\s*(\+*)(-*)\s*$/

function parseDiffStat(output: string): { path: string; added: number; removed: number }[] {
  const files: { path: string; added: number; removed: number }[] = []
  for (const line of output.split('\n')) {
    const m = STAT_LINE.exec(line)
    if (!m) continue
    const total = Number(m[2])
    const plus = m[3]!.length
    const minus = m[4]!.length
    // the +/- bar is drawn proportionally to the real counts, not one char per change,
    // so the split has to be recovered from the bar's ratio rather than counted directly
    const added = plus + minus === 0 ? total : Math.round((total * plus) / (plus + minus))
    files.push({ path: m[1]!, added, removed: total - added })
  }
  return files
}

export async function collectFacts(deps: FactsDeps, db: Database, session: Session): Promise<Facts> {
  const [logOut, diffOut] = await Promise.all([
    deps.git(['log', '--oneline', '--since', new Date(session.createdAt).toISOString()], session.cwd),
    deps.git(['diff', '--stat'], session.cwd),
  ])
  const agents = usageForSession(db, session.id).map((r) => ({ agent: r.agent, turns: r.turns, spend: spend(r) }))
  return { commits: parseLog(logOut), files: parseDiffStat(diffOut), agents }
}

// A field is quoted only when it has to be. 48% of this repository's own commit subjects
// contain a comma, so an unquoted row is the common case, not the edge one — and a shifted
// row makes every number after it wrong while still looking like a table.
function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function section(name: string, fields: string[], rows: string[][]): string {
  return [`${name}[${rows.length}]{${fields.join(',')}}:`, ...rows.map((r) => r.map(cell).join(','))].join('\n')
}

export function formatFacts(facts: Facts): string {
  const blocks: string[] = []
  if (facts.commits.length > 0) {
    blocks.push(section('commits', ['sha', 'subject'], facts.commits.map((c) => [c.sha, c.subject])))
  }
  if (facts.files.length > 0) {
    blocks.push(
      section(
        'files',
        ['path', 'added', 'removed'],
        facts.files.map((f) => [f.path, String(f.added), String(f.removed)]),
      ),
    )
  }
  if (facts.agents.length > 0) {
    blocks.push(
      section(
        'agents',
        ['agent', 'turns', 'spend'],
        facts.agents.map((a) => [a.agent, String(a.turns), a.spend]),
      ),
    )
  }
  return blocks.join('\n\n')
}

export function realFactsDeps(): FactsDeps {
  return {
    git: async (args, cwd) => {
      try {
        const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
        const stdout = await new Response(proc.stdout).text()
        await proc.exited
        return stdout
      } catch {
        return ''
      }
    },
  }
}
