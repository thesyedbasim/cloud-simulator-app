import { create } from 'zustand'
import { toast } from 'sonner'
import { designChanged, useStore } from '../store/useStore'
import { live } from './runtime'
import { sampleTrace, type Trace } from './trace'

export interface TraceUI {
  trace: Trace | null
  /** performance.now() when the animation began. */
  startedAt: number
  /** Dwell window (ms since start) for each hop, filled in by the canvas once it has measured the paths. */
  schedule: { start: number; end: number }[] | null
  /** Total animation length in ms. */
  total: number
  /** Trace one request. `via` steers it through a connection (clicking a moving dot on it). */
  start: (via?: string) => void
  clear: () => void
}

export const useTrace = create<TraceUI>((set) => ({
  trace: null,
  startedAt: 0,
  schedule: null,
  total: 0,
  start: (via) => {
    const arch = useStore.getState().architecture
    if (!live.result) return
    const trace = sampleTrace(arch, live.result, (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0, via)
    if (!trace) { toast("Nothing to trace", { description: 'Connect a Client to something first.' }); return }
    set({ trace, startedAt: performance.now(), schedule: null, total: 0 })
  },
  clear: () => set({ trace: null, schedule: null }),
}))

// a trace belongs to the design it was taken on: any edit (or opening another design) discards it
useStore.subscribe((s, p) => {
  if (designChanged(s.architecture, p.architecture) && useTrace.getState().trace) useTrace.getState().clear()
})
