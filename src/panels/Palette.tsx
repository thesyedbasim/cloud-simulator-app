import { AnimatePresence, motion } from 'motion/react'
import { GripVertical } from 'lucide-react'
import { useStore } from '../store/useStore'
import { KIND_INFO, type ComponentKind } from '../store/types'
import { addAtCenter } from '../canvas/CanvasView'
import { slide } from './ui'

const blank = (() => { const i = new Image(); i.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; return i })()

export function Palette() {
  const open = useStore((s) => s.leftOpen)
  const setDragKind = useStore((s) => s.setDragKind)
  return (
    <AnimatePresence>
      {open && (
        <motion.aside {...slide(-1)} className="panel absolute bottom-[var(--dock)] left-3 top-[68px] z-10 hidden w-48 flex-col gap-1 overflow-auto p-3 md:flex">
          <div className="label">Components</div>
          <div className="mb-1 text-[11px] text-dim">Drag onto the canvas, or click to add.</div>
          {(Object.keys(KIND_INFO) as ComponentKind[]).map((k) => (
            <button
              key={k}
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData('text/plain', k)
                ev.dataTransfer.effectAllowed = 'copy'
                ev.dataTransfer.setDragImage(blank, 0, 0)
                setDragKind(k)
              }}
              onDragEnd={() => setDragKind(null)}
              onClick={() => addAtCenter(k)}
              className="group flex cursor-grab items-start gap-1 rounded-control border border-transparent px-1 py-2 text-left transition-colors hover:border-line/20 hover:bg-line/5 active:scale-[0.97] active:cursor-grabbing"
            >
              <GripVertical size={14} className="mt-0.5 shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />
              <span>
                <span className="block font-medium">{KIND_INFO[k].label}</span>
                <span className="block text-[11px] leading-snug text-dim">{KIND_INFO[k].blurb}</span>
              </span>
            </button>
          ))}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
