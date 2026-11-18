import { create } from 'zustand'
import { toast } from 'sonner'
import { designChanged, useStore } from '../store/useStore'
import { live } from './runtime'
import { findTrace, sampleTraces, type Trace, type TraceOptions, type TraceSummary } from './trace'

export interface TraceUI {
  trace: Trace | null
  /** performance.now() when the animation began. */
  startedAt: number
  /** Dwell window (ms since start) for each hop, filled in by the canvas once it has measured the paths. */
  schedule: { start: number; end: number }[] | null
  /** Total animation length in ms. */
  total: number
  /** What to trace: where from, and what kind of outcome. */
  opts: TraceOptions
  /** 1 = follow a single request on the canvas; more = trace that many and summarise. */
  count: 1 | 100
  /** Result of a multi-request run. */
  summary: TraceSummary | null
  setOpts: (o: Partial<TraceOptions>) => void
  setCount: (n: 1 | 100) => void
  /** Trace one request. `via` steers it through a connection (clicking a moving dot on it). */
  start: (via?: string) => void
  clear: () => void
}

export const useTrace = create<TraceUI>((set) => ({
  trace: null,
  startedAt: 0,
  schedule: null,
  total: 0,
  opts: { outcome: 'any', type: 'any' },
  count: 1,
  summary: null,
  setOpts: (o) => set((s) => ({ opts: { ...s.opts, ...o } })),
  setCount: (count) => set({ count }),
  start: (via) => {
    const arch = useStore.getState().architecture
    if (!live.result) return
    const { opts, count } = useTrace.getState()
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0
    if (count > 1 && !via) {
      const summary = sampleTraces(arch, live.result, seed, count, opts.from, opts.type, opts.app)
      if (!summary) { toast("Nothing to trace", { description: 'Connect a Client to something first.' }); return }
      set({ summary, trace: null, schedule: null })
      return
    }
    if (opts.type === 'upload' && !arch.components.some((c) => c.kind === 'bucket' || c.kind === 'queue')) toast('No storage to upload to', { description: 'Add a Storage Bucket or Queue and connect to it. For now this is traced as a write.' })
    const { trace, matched } = findTrace(arch, live.result, seed, opts, via)
    if (!trace) { toast("Nothing to trace", { description: 'Connect a Client to something first.' }); return }
    if (!matched) toast('No matching request found', { description: `None of the sampled requests ${opts.outcome === 'fail' ? 'failed' : opts.outcome === 'slow' ? 'was unusually slow' : 'succeeded'} right now, so this is an ordinary one.` })
    set({ trace, summary: null, startedAt: performance.now(), schedule: null, total: 0 })
  },
  clear: () => set({ trace: null, schedule: null, summary: null }),
}))

// a trace belongs to the design it was taken on: any edit (or opening another design) discards it
useStore.subscribe((s, p) => {
  if (designChanged(s.architecture, p.architecture) && (useTrace.getState().trace || useTrace.getState().summary)) useTrace.getState().clear()
})
