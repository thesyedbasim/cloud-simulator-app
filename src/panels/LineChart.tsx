export interface Series { label: string; values: number[]; color: string; dashed?: boolean }

/** Small dependency-free line chart for the compare view. Shared x axis (seconds), optional fault marker. */
export function LineChart({ title, series, unit, faultAt, yMax, height = 120 }: { title: string; series: Series[]; unit: string; faultAt?: number; yMax?: number; height?: number }) {
  const W = 560
  const padL = 40, padR = 8, padT = 8, padB = 18
  const n = Math.max(...series.map((s) => s.values.length), 2)
  const hi = Math.max(yMax ?? 0, ...series.flatMap((s) => s.values), 1e-6) * 1.08
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR)
  const y = (v: number) => padT + (1 - v / hi) * (height - padT - padB)
  const ticks = [0, 0.5, 1].map((k) => k * hi)
  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v >= 10 ? `${Math.round(v)}` : v.toFixed(1))
  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex items-center justify-between text-xs">
        <span className="label">{title}</span>
        <span className="flex flex-wrap justify-end gap-x-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-dim">
              <svg width="14" height="6" aria-hidden><line x1="0" y1="3" x2="14" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '3 2' : undefined} /></svg>
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={`${title} over time: ${series.map((s) => s.label).join(' versus ')}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--bp-line)" strokeOpacity={0.12} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--bp-text-dim)" fontFamily="IBM Plex Mono">{fmt(t)}{t === ticks[ticks.length - 1] ? unit : ''}</text>
          </g>
        ))}
        {[0, 20, 40, 60].filter((s) => s <= n - 1).map((s) => (
          <text key={s} x={x(s)} y={height - 4} textAnchor="middle" fontSize="9" fill="var(--bp-text-dim)" fontFamily="IBM Plex Mono">{s}s</text>
        ))}
        {faultAt !== undefined && faultAt > 0 && (
          <g>
            <line x1={x(faultAt)} x2={x(faultAt)} y1={padT} y2={height - padB} stroke="var(--status-strained)" strokeDasharray="3 3" strokeOpacity={0.8} />
            <text x={x(faultAt) + 4} y={padT + 8} fontSize="9" fill="var(--status-strained)" fontFamily="IBM Plex Mono">fault</text>
          </g>
        )}
        {series.map((s) => (
          <polyline key={s.label} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '4 3' : undefined}
            points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
        ))}
      </svg>
    </figure>
  )
}
