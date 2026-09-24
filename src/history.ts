// What was typed at the prompt, kept across runs the way every shell and agent CLI keeps it, and
// per project: the line you want back in a repository is the one you typed in that repository.
// One JSON object per line, because an entry can itself span lines.
export interface History {
  /** this project's entries, newest first, without repeats */
  entries: () => string[]
  add: (text: string) => void
}

const KEEP = 1000

interface Entry {
  cwd: string
  text: string
}

function parse(raw: string): Entry[] {
  const out: Entry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as Partial<Entry>
      if (typeof e.cwd === 'string' && typeof e.text === 'string') out.push({ cwd: e.cwd, text: e.text })
    } catch {
      // a line torn by a crash mid-write costs that line, not the file
    }
  }
  return out
}

// Owner-only, because what gets typed at a prompt includes what gets pasted into one. Bun.write's
// `mode` is ignored for a string on Bun 1.4.2 (measured), so the file is made private once, when it
// is created, with chmod resolved absolutely the way the store resolves mkdir.
async function save(path: string, body: string): Promise<void> {
  const created = !(await Bun.file(path).exists())
  await Bun.write(path, body)
  if (created) Bun.spawnSync([Bun.which('chmod') ?? '/bin/chmod', '600', path], { stdout: 'ignore', stderr: 'ignore' })
}

export async function fileHistory(path: string, cwd: string): Promise<History> {
  const file = Bun.file(path)
  let all: Entry[] = []
  try {
    if (await file.exists()) all = parse(await file.text())
  } catch {
    all = []
  }
  let writing: Promise<unknown> = Promise.resolve()

  const entries = (): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]!
      if (e.cwd !== cwd || seen.has(e.text)) continue
      seen.add(e.text)
      out.push(e.text)
    }
    return out
  }

  return {
    entries,
    add(text) {
      if (text.trim() === '') return
      const last = all.at(-1)
      if (last && last.cwd === cwd && last.text === text) return
      all.push({ cwd, text })
      if (all.length > KEEP) all = all.slice(-KEEP)
      const body = `${all.map((e) => JSON.stringify(e)).join('\n')}\n`
      // serialized, and never allowed to fail the prompt: history is a convenience
      writing = writing.then(() => save(path, body)).catch(() => undefined)
    },
  }
}

/** history kept in memory only: a test, or a store that cannot be written */
export function memoryHistory(initial: string[] = []): History {
  const all = [...initial].reverse()
  return {
    entries: () => [...new Set([...all].reverse())],
    add: (text) => {
      if (text.trim() !== '' && all.at(-1) !== text) all.push(text)
    },
  }
}
