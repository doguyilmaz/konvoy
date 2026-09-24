import type { Database } from 'bun:sqlite'

// What was typed at the prompt, kept across runs the way every shell and agent CLI keeps it, and
// per project: the line you want back in a repository is the one you typed in that repository.
// It lives in the store rather than a file of its own. Two REPLs open at once each rewrote a shared
// file from their own copy and erased the other's entries; SQLite already serialises writers, and
// the store is already private, which a prompt that held a pasted secret needs.
export interface History {
  /** this project's entries, newest first, without repeats */
  entries: () => string[]
  add: (text: string) => void
}

const KEEP = 1000

export function storeHistory(db: Database, cwd: string): History {
  return {
    entries() {
      const rows = db
        .query('SELECT text FROM prompt_history WHERE cwd = $cwd ORDER BY id DESC LIMIT $limit')
        .all({ cwd, limit: KEEP }) as { text: string }[]
      return [...new Set(rows.map((r) => r.text))]
    },
    add(text) {
      if (text.trim() === '') return
      try {
        const last = db.query('SELECT text FROM prompt_history WHERE cwd = $cwd ORDER BY id DESC LIMIT 1').get({ cwd }) as
          | { text: string }
          | null
        if (last?.text === text) return
        db.query('INSERT INTO prompt_history (cwd, text, at) VALUES ($cwd, $text, $at)').run({ cwd, text, at: Date.now() })
        db.query(
          `DELETE FROM prompt_history WHERE cwd = $cwd AND id <= (
             SELECT id FROM prompt_history WHERE cwd = $cwd ORDER BY id DESC LIMIT 1 OFFSET $keep)`,
        ).run({ cwd, keep: KEEP })
      } catch {
        // history is a convenience: a store that cannot take the write never fails the prompt
      }
    },
  }
}

/** history kept in memory only: a test, or a prompt with no store behind it */
export function memoryHistory(initial: string[] = []): History {
  const all = [...initial].reverse()
  return {
    entries: () => [...new Set([...all].reverse())],
    add: (text) => {
      if (text.trim() !== '' && all.at(-1) !== text) all.push(text)
    },
  }
}
