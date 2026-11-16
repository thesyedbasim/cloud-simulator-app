/** Tiny SVG sparkline. A full chart library is overkill for ~60 points. */
export function Sparkline({ values, color = 'var(--bp-accent)', w = 64, h = 18, max }: { values: number[]; color?: string; w?: number; h?: number; max?: number }) {
  if (values.length < 2) return <svg width={w} height={h} aria-hidden />
  const hi = Math.max(max ?? 0, ...values, 1e-6)
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 1 - (v / hi) * (h - 2)).toFixed(1)}`)
  return (
    <svg width={w} height={h} aria-hidden className="shrink-0 overflow-visible">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  )
}
