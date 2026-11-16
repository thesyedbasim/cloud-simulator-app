import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ChevronDown, Crosshair, X } from 'lucide-react'
import { useSim } from '../sim/runtime'
import { useStore } from '../store/useStore'

function Body({ insight }: { insight: NonNullable<ReturnType<typeof useSim.getState>['insight']> }) {
  const [open, setOpen] = useState(false)
  const [first, ...rest] = insight.reasons
  return (
    <div className="min-w-0 flex-1">
      <div className="font-semibold">{insight.title}</div>
      <p className="mt-0.5 text-[12px] leading-snug text-dim">{first}</p>
      {open && (
        <>
          <ul className="mt-1 space-y-1 text-[12px] leading-snug text-dim">{rest.map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="mt-2 rounded-control bg-line/[0.05] px-2 py-1.5 text-[12px] leading-snug"><span className="label mr-1.5">Try</span>{insight.hint}</p>
        </>
      )}
      <div className="mt-2 flex gap-2">
        <button onClick={() => useStore.getState().select(insight.nodeId)} className="flex items-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1 text-xs transition-colors hover:bg-line/10 active:scale-95"><Crosshair size={12} /> Inspect it</button>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-dim transition-colors hover:bg-line/10 hover:text-text">{open ? 'Less' : 'Why? and what to try'} <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} /></button>
      </div>
    </div>
  )
}

/** Plain-language "what broke and why". Appears while something is failing, goes away when it recovers. */
export function InsightCard() {
  const insight = useSim((s) => s.insight)
  const dismissed = useSim((s) => s.dismissedKey)
  const show = insight && insight.key !== dismissed
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-[var(--dock)] z-10 flex justify-center md:left-[204px] md:right-[252px]">
      <AnimatePresence>
        {show && (
          <motion.section
            key="insight"
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="panel pointer-events-auto w-full max-w-md border-failed/40 p-3 shadow-lg shadow-failed/10"
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-failed/15 text-failed"><AlertTriangle size={14} /></span>
              <Body key={insight.key} insight={insight} />
              <button onClick={() => useSim.getState().dismissInsight()} aria-label="Dismiss" className="grid size-6 shrink-0 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><X size={14} /></button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
