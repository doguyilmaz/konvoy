import DefaultTheme from 'vitepress/theme'
import { useData, useRoute, type Theme } from 'vitepress'
import { nextTick, onMounted, watch } from 'vue'

export default {
  extends: DefaultTheme,
  setup() {
    const { isDark } = useData()
    const route = useRoute()
    const render = async (): Promise<void> => {
      const nodes = [...document.querySelectorAll<HTMLElement>('pre.mermaid')]
      if (nodes.length === 0) return
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default' })
      for (const node of nodes) {
        node.dataset.source ??= node.textContent ?? ''
        node.textContent = node.dataset.source
        node.removeAttribute('data-processed')
      }
      await mermaid.run({ nodes })
    }
    onMounted(render)
    watch(() => route.path, () => nextTick(render))
    watch(isDark, render)
  },
} satisfies Theme
