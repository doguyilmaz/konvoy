import { defineConfig } from 'vitepress'
import { description, version } from '../../package.json'

const repo = 'https://github.com/doguyilmaz/konvoy'

export default defineConfig({
  title: 'konvoy',
  description,
  base: '/konvoy/',
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/konvoy/logo.svg' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/konvoy/favicon-32.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/konvoy/apple-touch-icon.png' }],
  ],
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    nav: [
      { text: 'Releases', link: `${repo}/releases` },
      { text: 'npm', link: 'https://www.npmjs.com/package/@doguyilmaz/konvoy' },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    footer: { message: `konvoy ${version} · MIT` },
  },
  markdown: {
    config(md) {
      const fence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]!
        if (token.info.trim() !== 'mermaid') return fence(tokens, idx, options, env, self)
        return `<pre class="mermaid" v-pre>${md.utils.escapeHtml(token.content)}</pre>`
      }
    },
  },
})
