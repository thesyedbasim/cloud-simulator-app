import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore } from '../store/useStore'
import { useSim } from '../sim/runtime'
import { KIND_INFO } from '../store/types'
import { specLine } from '../sim/capacity'
import { levelOf } from '../canvas/tier'

const DOT = { healthy: 'bg-healthy', strained: 'bg-strained', failed: 'bg-failed' } as const

/** Follows the pointer while it is over a component: name, hardware, live load. */
export function HoverTooltip() {
  const id = useStore((s) => s.hoverId)
  const comp = useStore((s) => s.architecture.components.find((c) => c.id === s.hoverId))
  const selected = useStore((s) => s.selectedId)
  const node = useSim((s) => (id ? s.nodes[id] : undefined))
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = box.current
      if (!el) return
      const w = el.offsetWidth || 200
      const x = Math.min(e.clientX + 16, window.innerWidth - w - 12)
      el.style.transform = `translate(${x}px, ${e.clientY + 18}px)`
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])

  return (
    <div ref={box} className="pointer-events-none fixed left-0 top-0 z-30" style={{ transform: 'translate(-999px,-999px)' }}>
      <AnimatePresence>
        {comp && (
          <motion.div key={comp.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
            className="panel min-w-44 max-w-64 px-3 py-2 shadow-lg shadow-line/10">
            <div className="flex items-center gap-2">
              {node && comp.kind !== 'client' && <span className={`size-2 rounded-full ${DOT[node.health]}`} />}
              <span className="font-semibold">{comp.name}</span>
              <span className="label ml-auto">{KIND_INFO[comp.kind].label} · Lv {levelOf(comp)}</span>
            </div>
            <div className="data mt-1 text-xs text-dim">{specLine(comp.kind, comp.config)}</div>
            {node && comp.kind !== 'client' && (
              <div className="data mt-1 flex gap-3 text-xs">
                <span>{Math.round(node.util * 100)}% load</span>
                <span>{Math.round(node.offered)} rps</span>
                {node.dropped >= 1 && <span className="text-failed">{Math.round(node.dropped)} dropped</span>}
              </div>
            )}
            <div className="mt-1.5 text-[11px] text-dim">{selected === comp.id ? 'Selected · settings in the inspector' : 'Click to inspect and configure'}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
