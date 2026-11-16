export interface Mark { x: number; label: string; color: string }

/** Steady-state errors against load: the knee of the curve is where the design breaks. */
export function CurveChart({ points, marks, yMax = 100 }: { points: { x: number; y: number }[]; marks: Mark[]; yMax?: number }) {
  const W = 560, H = 150
  const padL = 40, padR = 12, padT = 16, padB = 22
  const xs = points.map((p) => p.x)
  const x0 = 0
  const x1 = Math.max(...xs, ...marks.map((m) => m.x)) * 1.02
  const x = (v: number) => padL + ((v - x0) / (x1 - x0)) * (W - padL - padR)
  const y = (v: number) => padT + (1 - Math.min(v, yMax) / yMax) * (H - padT - padB)
  const line = points.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`)
  const ticks = [0, 25, 50, 75, 100].filter((t) => t <= yMax)
  const nice = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`)
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((k) => x1 * k)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Error rate against load. Errors stay near zero until the break point, then climb.">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--bp-line)" strokeOpacity={0.12} />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--bp-text-dim)" fontFamily="IBM Plex Mono">{t}%</text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--bp-text-dim)" fontFamily="IBM Plex Mono">{nice(t)}</text>
      ))}
      <text x={W - padR} y={H - 6} textAnchor="end" fontSize="9" fill="var(--bp-text-dim)" fontFamily="IBM Plex Mono" dy={-11}>rps</text>
      <polygon points={`${x(points[0].x)},${y(0)} ${line.join(' ')} ${x(points[points.length - 1].x)},${y(0)}`} fill="var(--status-failed)" fillOpacity={0.1} />
      <polyline points={line.join(' ')} fill="none" stroke="var(--status-failed)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {marks.map((m, i) => (
        <g key={m.label}>
          <line x1={x(m.x)} x2={x(m.x)} y1={padT - 4} y2={H - padB} stroke={m.color} strokeWidth={1.5} strokeDasharray="4 3" />
          <text x={x(m.x) + (i % 2 ? 5 : -5)} y={padT + 4} textAnchor={i % 2 ? 'start' : 'end'} fontSize="9.5" fill={m.color} fontFamily="IBM Plex Mono" fontWeight={500}>{m.label}</text>
        </g>
      ))}
    </svg>
  )
}
