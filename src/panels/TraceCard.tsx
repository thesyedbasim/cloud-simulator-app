import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Minus, Route, RotateCw, X } from 'lucide-react'
import { useTrace } from '../sim/traceStore'
import { KIND_INFO } from '../store/types'

const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`)

/** One request's journey: where it went, how long each hop took, and how it ended. */
export function TraceCard() {
  const trace = useTrace((s) => s.trace)
  const schedule = useTrace((s) => s.schedule)
  const startedAt = useTrace((s) => s.startedAt)
  const total = useTrace((s) => s.total)
  const [now, setNow] = useState(() => performance.now())

  // follow the canvas animation: which hop is the dot at, and has the request finished?
  useEffect(() => {
    if (!trace) return
    const t = setInterval(() => setNow(performance.now()), 90)
    return () => clearInterval(t)
  }, [trace])

  const elapsed = now - startedAt
  const reached = (i: number) => schedule ? elapsed >= schedule[i].start : false
  const current = schedule ? schedule.findLastIndex((w) => elapsed >= w.start) : -1
  const done = !!schedule && total > 0 && elapsed > total
  const maxMs = trace ? Math.max(1, ...trace.hops.map((h) => h.ms)) : 1

  return (
    <div className="pointer-events-none absolute inset-x-3 top-[68px] z-10 flex justify-center md:left-[204px] md:right-[252px]">
      <AnimatePresence>
        {trace && (
          <motion.section
            key="trace"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            aria-label="Request trace"
            className="panel pointer-events-auto w-full max-w-md p-3 shadow-lg shadow-line/10"
            style={{ background: 'var(--bp-surface)' }}
          >
            <div className="flex items-center gap-2">
              <Route size={14} className="text-accent" />
              <span className="font-semibold">Request trace</span>
              {done ? (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${trace.outcome === 'ok' ? 'bg-healthy/15 text-healthy' : trace.outcome === 'blocked' ? 'bg-line/10 text-dim' : 'bg-failed/15 text-failed'}`}>
                  {trace.outcome === 'ok' ? `Completed in ${fmtMs(trace.totalMs)}` : trace.outcome === 'blocked' ? 'Blocked by geo rule' : 'Failed'}
                </span>
              ) : <span className="text-[11px] text-dim">following…</span>}
              <span className="ml-auto flex gap-1">
                <button onClick={() => useTrace.getState().start()} title="Trace another request" aria-label="Trace another request" className="grid size-6 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><RotateCw size={13} /></button>
                <button onClick={() => useTrace.getState().clear()} aria-label="Close trace" className="grid size-6 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><X size={14} /></button>
              </span>
            </div>

            <ol className="mt-2 flex flex-col gap-1">
              {trace.hops.map((h, i) => {
                const seen = reached(i)
                const bad = h.outcome === 'dropped'
                const blocked = h.outcome === 'blocked'
                return (
                  <li key={i} className={`grid grid-cols-[88px_1fr_58px] items-center gap-2 rounded px-1.5 py-1 transition-opacity ${seen ? 'opacity-100' : 'opacity-35'} ${i === current && !done ? 'bg-accent/10' : ''}`}>
                    <div className="truncate text-[12px] font-medium" title={h.name}>{h.name}</div>
                    <div className="min-w-0">
                      <div className="h-1.5 rounded-full bg-line/10">
                        <div className={`h-full rounded-full transition-[width] duration-300 ${bad ? 'bg-failed' : blocked ? 'bg-dim' : h.outcome === 'hit' ? 'bg-healthy' : 'bg-accent'}`} style={{ width: seen ? `${Math.max(3, (h.ms / maxMs) * 100)}%` : 0 }} />
                      </div>
                      <div className={`mt-0.5 truncate text-[10px] leading-tight ${bad ? 'text-failed' : 'text-dim'}`} title={h.note}>{KIND_INFO[h.kind].label} · {h.note}</div>
                    </div>
                    <div className="data text-right text-[11px]">{h.kind === 'client' ? '–' : fmtMs(h.ms)}</div>
                  </li>
                )
              })}
            </ol>

            <div className="mt-2 flex items-start gap-2 border-t border-line/10 pt-2 text-[12px]">
              {done ? (
                <>
                  <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-white ${trace.outcome === 'ok' ? 'bg-healthy' : trace.outcome === 'blocked' ? 'bg-dim' : 'bg-failed'}`}>{trace.outcome === 'ok' ? <Check size={10} /> : trace.outcome === 'blocked' ? <Minus size={10} /> : <X size={10} />}</span>
                  <span className="text-dim"><span className="text-text">{trace.summary}</span> Sampled from the current numbers, so another request can differ.</span>
                </>
              ) : <span className="text-dim">Watch the highlighted dot on the canvas. Each row fills as the request reaches it.</span>}
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
