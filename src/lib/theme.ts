/** Reads design tokens from CSS so the canvas always matches the UI. */
const read = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export const theme = () => ({
  bg: read('--bp-bg'),
  grid: read('--bp-grid'),
  line: read('--bp-line'),
  text: read('--bp-text'),
  dim: read('--bp-text-dim'),
  accent: read('--bp-accent'),
  healthy: read('--status-healthy'),
  strained: read('--status-strained'),
  failed: read('--status-failed'),
})
export type Theme = ReturnType<typeof theme>
