import { History } from 'lucide-react'
import { useSim } from '../sim/runtime'

/**
 * Rewind. The track is drawn over the error rate, so the moment things broke is visible as a red bump and
 * a tick. Dragging pauses the simulation and shows exactly what the canvas, metrics and explanation looked
 * like then; "Live" (or Space) returns to the present.
 */
export function Timeline() {
  const tl = useSim((s) => s.timeline)
  const scrubT = useSim((s) => s.scrubT)
  const { scrubTo, goLive } = useSim.getState()
  const live = scrubT === null

  if (!tl || tl.t1 - tl.t0 < 1) {
    return <div className="flex h-8 items-center gap-2 border-b border-line/10 px-4 text-[11px] text-dim"><History size={12} /> Timeline fills in as the simulation runs</div>
  }

  const span = tl.t1 - tl.t0
  const value = scrubT ?? tl.t1
  const W = 600, H = 22
  const hi = Math.max(5, ...tl.err)
  const pts = tl.err.map((e, i) => `${((i / Math.max(1, tl.err.length - 1)) * W).toFixed(1)},${(H - 1 - (e / hi) * (H - 3)).toFixed(1)}`)
  const failPct = tl.firstFail === null ? null : ((tl.firstFail - tl.t0) / span) * 100
  const ago = tl.t1 - value

  return (
    <div className="flex h-8 items-center gap-3 border-b border-line/10 px-4">
      <span className="label flex shrink-0 items-center gap-1.5"><History size={12} /> Rewind</span>
      <div className="relative h-6 min-w-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill="var(--status-failed)" fillOpacity={0.14} />
          <polyline points={pts.join(' ')} fill="none" stroke="var(--status-failed)" strokeOpacity={0.6} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        </svg>
        {failPct !== null && <span className="pointer-events-none absolute bottom-0 top-0 w-px bg-failed" style={{ left: `${failPct}%` }} title="Errors first exceed 2% here" />}
        <input
          type="range"
          min={tl.t0}
          max={tl.t1}
          step="any"
          value={value}
          onChange={(e) => scrubTo(Number(e.target.value))}
          aria-label="Rewind the simulation"
          aria-valuetext={live ? 'Live' : `${ago.toFixed(1)} seconds ago`}
          className="absolute inset-0 h-full w-full cursor-ew-resize appearance-none bg-transparent accent-accent"
        />
      </div>
      <span className="data w-16 shrink-0 text-right text-xs text-dim">{live ? 'now' : `−${ago.toFixed(1)} s`}</span>
      {live ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-healthy"><span className="size-1.5 animate-pulse rounded-full bg-healthy" /> Live</span>
      ) : (
        <button onClick={goLive} className="shrink-0 rounded-control bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25 active:scale-95">Back to live</button>
      )}
    </div>
  )
}
