import { expect, test } from 'bun:test'
import { version } from '../package.json'
import { renderSite } from '../scripts/site'

const readme = await Bun.file(new URL('../README.md', import.meta.url)).text()
const page = renderSite(readme)

test('the site carries every README section', () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!)
  expect(headings.length).toBeGreaterThan(3)
  for (const h of headings) expect(page).toContain(`>${h}</a></h2>`)
})

test('mermaid fences become diagrams, not code', () => {
  expect(page).not.toContain('language-mermaid')
  expect(page.match(/<pre class="mermaid">/g)?.length).toBe(readme.match(/^```mermaid$/gm)?.length)
})

test('the footer names the released version', () => {
  expect(page).toContain(`konvoy ${version} · MIT`)
})
