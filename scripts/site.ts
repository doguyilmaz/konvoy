import { description, version } from '../package.json'

const REPO = 'https://github.com/doguyilmaz/konvoy'
const SITE = 'https://doguyilmaz.github.io/konvoy/'
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs'

export function renderSite(readme: string): string {
  const body = Bun.markdown
    .html(readme, { headings: true })
    .replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_, chart: string) => `<pre class="mermaid">${chart}</pre>`)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>konvoy</title>
<meta name="description" content="${description}">
<meta property="og:title" content="konvoy">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${SITE}">
<link rel="canonical" href="${SITE}">
<style>
:root { --bg: #fdfdfc; --fg: #1d1d1b; --muted: #6b6b66; --line: #e6e5e0; --code: #f3f2ee; --link: #1f5fbf; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #141413; --fg: #e8e7e3; --muted: #9a9993; --line: #2b2b29; --code: #1e1e1c; --link: #7fb0ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, sans-serif; }
header, main, footer { max-width: 46rem; margin: 0 auto; padding: 0 16px; }
header { display: flex; gap: 1.25rem; justify-content: flex-end; padding-top: 1.25rem; font-size: 14px; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 2.25rem; margin: 1.5rem 0 0.5rem; }
h2 { margin-top: 2.5rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--line); }
h1 a, h2 a, h3 a { color: inherit; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code); padding: 0.9rem 1rem; border-radius: 8px; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; }
pre.mermaid { background: none; text-align: center; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--line); padding: 0.3rem 0.6rem; }
footer { color: var(--muted); font-size: 14px; padding: 3rem 16px 2rem; }
</style>
</head>
<body>
<header><a href="${REPO}">GitHub</a><a href="${REPO}/releases">Releases</a><a href="https://www.npmjs.com/package/@doguyilmaz/konvoy">npm</a></header>
<main>
${body}</main>
<footer>konvoy ${version} · MIT</footer>
<script type="module">
import mermaid from '${MERMAID}'
mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' })
</script>
</body>
</html>
`
}

if (import.meta.main) {
  const out = new URL('../dist/site/index.html', import.meta.url).pathname
  await Bun.write(out, renderSite(await Bun.file(new URL('../README.md', import.meta.url)).text()))
  console.log(`wrote ${out}`)
}
