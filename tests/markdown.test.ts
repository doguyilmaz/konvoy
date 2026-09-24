import { expect, test } from 'bun:test'
import { inline, markdownRenderer, type MarkdownTheme } from '../src/markdown'
import { palette } from '../src/style'

// Tags instead of escape codes, so an assertion reads as the structure it checks.
const tag = (name: string) => (t: string) => `<${name}>${t}</${name}>`
const p = {
  ...palette(false),
  bold: tag('b'),
  italic: tag('i'),
  dim: tag('dim'),
  underline: tag('u'),
}
const theme: MarkdownTheme = { p, accent: tag('a'), code: tag('code') }
const render = (lines: string[]): string[] => {
  const md = markdownRenderer(theme)
  return lines.map((l) => md.line(l))
}

test('headings lose their markers and keep their weight', () => {
  expect(render(['# Plan', '### Details ###'])).toEqual(['<b><a>Plan</a></b>', '<b>Details</b>'])
})

test('bullets become bullets, tasks become boxes, numbers keep their order', () => {
  expect(render(['- one', '  * nested', '1. first', '- [ ] todo', '- [x] done'])).toEqual([
    '<a>•</a> one',
    '  <a>•</a> nested',
    '<a>1.</a> first',
    '<a>☐</a> todo',
    '<a>☑</a> done',
  ])
})

test('emphasis needs its markers to hug the text, so arithmetic and snake_case survive', () => {
  expect(inline('**bold** and *it* and __also__', theme)).toBe('<b>bold</b> and <i>it</i> and <b>also</b>')
  expect(inline('2 * 3 * 4', theme)).toBe('2 * 3 * 4')
  expect(inline('retry_count and max_retry_count', theme)).toBe('retry_count and max_retry_count')
  expect(inline('** not bold **', theme)).toBe('** not bold **')
})

test('a code span is literal: nothing inside it is formatted', () => {
  expect(inline('run `**not bold**` then `x_y_z`', theme)).toBe('run <code>**not bold**</code> then <code>x_y_z</code>')
  expect(inline('``a ` b``', theme)).toBe('<code>a ` b</code>')
})

test('links show their text, and their target when it says something the text does not', () => {
  expect(inline('see [the docs](https://x.dev/a)', theme)).toBe('see <u>the docs</u> <dim>(https://x.dev/a)</dim>')
  expect(inline('[https://x.dev](https://x.dev)', theme)).toBe('<u>https://x.dev</u>')
})

test('a fenced block is code until its own fence closes it, and Markdown inside it is left alone', () => {
  expect(render(['```ts', '# not a heading', '- not a bullet', '````', 'after **x**'])).toEqual([
    '<dim>```ts</dim>',
    '<code># not a heading</code>',
    '<code>- not a bullet</code>',
    // a longer fence of the same kind closes it
    '<dim>````</dim>',
    'after <b>x</b>',
  ])
  // a shorter one, or one of the other kind, is a line of code
  expect(render(['````', '```', '~~~', '````'])).toEqual(['<dim>````</dim>', '<code>```</code>', '<code>~~~</code>', '<dim>````</dim>'])
})

test('a preview of an unfinished line renders it without advancing the fence state', () => {
  const md = markdownRenderer(theme)
  expect(md.preview('```ts')).toBe('<dim>```ts</dim>')
  // the preview did not open a fence, so this is still prose
  expect(md.line('**x**')).toBe('<b>x</b>')
})

test('quotes and rules are drawn, and a table keeps its columns', () => {
  const [quote, rule, row, sep] = render(['> careful', '---', '| a | **b** |', '|---|---|'])
  expect(quote).toBe('<dim>│</dim> <i>careful</i>')
  expect(rule).toStartWith('<dim>───')
  expect(row).toBe('<dim>|</dim> a <dim>|</dim> <b>b</b> <dim>|</dim>')
  expect(sep).toBe('<dim>|---|---|</dim>')
})

test('a heading keeps a # that is part of its words', () => {
  expect(render(['## Learning C#', '# Title ##'])).toEqual(['<b><a>Learning C#</a></b>', '<b><a>Title</a></b>'])
})
