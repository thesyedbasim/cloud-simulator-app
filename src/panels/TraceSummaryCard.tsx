import { AnimatePresence, motion } from 'motion/react'
import { RotateCw, Route, X } from 'lucide-react'
import { useTrace } from '../sim/traceStore'

const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`)
const pct = (a: number, n: number) => `${Math.round((a / n) * 100)}%`

/** Result of tracing many requests at once: how they ended, how long they took, and where the failures happened. */
export function TraceSummaryCard() {
  const s = useTrace((t) => t.summary)
  return (
    <div className="pointer-events-none absolute inset-x-3 top-[68px] z-10 flex justify-center md:left-[204px] md:right-[252px]">
      <AnimatePresence>
        {s && (
          <motion.section key="summary" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }} aria-label="Trace summary"
            className="panel pointer-events-auto w-full max-w-md p-3 shadow-lg shadow-line/10" style={{ background: 'var(--bp-surface)' }}>
            <div className="flex items-center gap-2">
              <Route size={14} className="text-accent" />
              <span className="font-semibold">{s.n} {s.type === 'any' ? '' : `${s.type} `}requests traced</span>
              <span className="ml-auto flex gap-1">
                <button onClick={() => useTrace.getState().start()} title="Trace again" aria-label="Trace again" className="grid size-6 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><RotateCw size={13} /></button>
                <button onClick={() => useTrace.getState().clear()} aria-label="Close summary" className="grid size-6 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><X size={14} /></button>
              </span>
            </div>

            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-line/10" role="img" aria-label={`${s.ok} succeeded, ${s.dropped} failed, ${s.blocked} blocked`}>
              <div className="bg-healthy" style={{ width: pct(s.ok, s.n) }} />
              <div className="bg-dim" style={{ width: pct(s.blocked, s.n) }} />
              <div className="bg-failed" style={{ width: pct(s.dropped, s.n) }} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
              <span><span className="data text-healthy">{pct(s.ok, s.n)}</span> <span className="text-dim">succeeded</span></span>
              <span><span className="data text-failed">{pct(s.dropped, s.n)}</span> <span className="text-dim">failed</span></span>
              {s.blocked > 0 && <span><span className="data">{pct(s.blocked, s.n)}</span> <span className="text-dim">blocked (geo)</span></span>}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line/10 pt-2">
              <div><div className="label">Median</div><div className="data text-sm">{s.ok ? fmtMs(s.p50) : '–'}</div></div>
              <div><div className="label">Slowest 1%</div><div className="data text-sm">{s.ok ? fmtMs(s.p99) : '–'}</div></div>
            </div>

            {s.failures.length > 0 && (
              <div className="mt-2 border-t border-line/10 pt-2">
                <div className="label mb-1">Where failures happened</div>
                <ul className="flex flex-col gap-0.5 text-[12px]">
                  {s.failures.slice(0, 3).map((f) => (
                    <li key={f.nodeId} className="flex justify-between"><span className="truncate">{f.name}</span><span className="data text-dim">{f.count} of {s.dropped}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2 text-[11px] text-dim">Sampled from the current numbers, so another run can differ a little.</p>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
