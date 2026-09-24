import type { Paint, Palette } from './style'

// Every agent konvoy drives answers in Markdown, and a terminal shows Markdown as punctuation:
// `**bold**`, backticks, `#` headings. Each CLI renders its own answers; konvoy printed theirs
// raw. This renders a line at a time, because an answer arrives a line at a time, and only ever
// for a terminal - a pipe or a file still gets the agent's exact bytes (src/render.ts decides).

export interface MarkdownTheme {
  p: Palette
  /** headings and list bullets wear the speaking agent's colour */
  accent: Paint
  /** inline code and code blocks */
  code: Paint
}

export interface MarkdownRenderer {
  /** one complete line, rendered; state (an open code fence) carries to the next */
  line: (raw: string) => string
  /** a line still being written: rendered the same way, without advancing any state */
  preview: (raw: string) => string
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const TABLE_RULE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/

export function markdownRenderer(theme: MarkdownTheme, width: () => number = () => 80): MarkdownRenderer {
  const { p, accent, code } = theme
  let fence: { marker: string; indent: string } | null = null

  const render = (raw: string, advance: boolean): string => {
    if (fence) {
      const close = FENCE.exec(raw)
      if (close && close[2]!.startsWith(fence.marker[0]!) && close[2]!.length >= fence.marker.length && close[3] === '') {
        if (advance) fence = null
        return p.dim(raw)
      }
      return code(raw)
    }

    const open = FENCE.exec(raw)
    if (open) {
      if (advance) fence = { marker: open[2]!, indent: open[1]! }
      return p.dim(raw)
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      const level = heading[1]!.length
      const text = inline(heading[2]!, theme)
      return level <= 2 ? p.bold(accent(text)) : p.bold(text)
    }

    if (RULE.test(raw)) return p.dim('─'.repeat(Math.max(3, Math.min(width() - 1, 60))))

    const quote = QUOTE.exec(raw)
    if (quote) return `${p.dim('│')} ${p.italic(inline(quote[1]!, theme))}`

    const bullet = BULLET.exec(raw)
    if (bullet) {
      const [, indent, , rest] = bullet
      const task = /^\[([ xX])\]\s+(.*)$/.exec(rest!)
      if (task) return `${indent}${accent(task[1] === ' ' ? '☐' : '☑')} ${inline(task[2]!, theme)}`
      return `${indent}${accent('•')} ${inline(rest!, theme)}`
    }

    const ordered = ORDERED.exec(raw)
    if (ordered) return `${ordered[1]}${accent(ordered[2]!)} ${inline(ordered[3]!, theme)}`

    if (TABLE_RULE.test(raw) && raw.includes('-')) return p.dim(raw)
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      return raw
        .split('|')
        .map((cell, i, all) => (i === 0 || i === all.length - 1 ? cell : inline(cell, theme)))
        .join(p.dim('|'))
    }

    return inline(raw, theme)
  }

  return {
    line: (raw) => render(raw, true),
    preview: (raw) => render(raw, false),
  }
}

// Inline spans, outside code spans only: a backtick run is literal text, so `**` inside one is
// never bold. Markers must hug their text (`**x**`, not `** x **`), and an underscore inside a
// word is never emphasis, which is what keeps snake_case identifiers intact.
export function inline(text: string, theme: MarkdownTheme): string {
  const { p, code } = theme
  const parts = text.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i]!
    if (i % 3 === 0) out += emphasis(segment, p)
    else if (i % 3 === 2) out += code(segment)
  }
  return out
}

function emphasis(text: string, p: Palette): string {
  return text
    .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_, label: string, url: string) =>
      label === url ? p.underline(label) : `${p.underline(label)} ${p.dim(`(${url})`)}`,
    )
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, __, body: string) => p.bold(body))
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, (_, body: string) => p.italic(body))
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, (_, body: string) => p.italic(body))
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, (_, body: string) => `\x1b[9m${body}\x1b[29m`)
}
