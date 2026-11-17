import { AnimatePresence, motion } from 'motion/react'
import { GripVertical } from 'lucide-react'
import { useStore } from '../store/useStore'
import { KIND_INFO, type ComponentKind } from '../store/types'
import { addAtCenter } from '../canvas/CanvasView'
import { slide } from './ui'
import { useEffect, useState } from 'react'
import { renderPaletteIcons } from '../canvas/paletteIcons'

const blank = (() => { const i = new Image(); i.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; return i })()

const KINDS = Object.keys(KIND_INFO) as ComponentKind[]

/** Pictures of the components exactly as the canvas draws them; redrawn when the light/dark theme changes. */
function useIcons() {
  const [icons, setIcons] = useState<Partial<Record<ComponentKind, string>>>({})
  useEffect(() => {
    let alive = true
    const run = () => { document.fonts.ready.then(() => renderPaletteIcons(KINDS)).then((i) => { if (alive) setIcons(i) }).catch(() => {}) }
    run()
    const mo = new MutationObserver(run)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    return () => { alive = false; mo.disconnect() }
  }, [])
  return icons
}

export function Palette() {
  const icons = useIcons()
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
              className="group flex cursor-grab items-center gap-1.5 rounded-control border border-transparent px-1.5 py-1.5 text-left transition-colors hover:border-line/20 hover:bg-line/5 active:scale-[0.97] active:cursor-grabbing"
            >
              <span className="flex h-8 w-9 shrink-0 items-center justify-center">{icons[k] && <img src={icons[k]} alt="" draggable={false} className="max-h-full max-w-full object-contain" />}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between font-medium">{KIND_INFO[k].label}<GripVertical size={12} className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" /></span>
                <span className="block text-[11px] leading-snug text-dim">{KIND_INFO[k].blurb}</span>
              </span>
            </button>
          ))}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
