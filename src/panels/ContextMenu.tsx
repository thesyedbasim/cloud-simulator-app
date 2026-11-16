import { useEffect } from 'react'
import { Copy, RotateCcw, Skull, Snail, Trash2, Minus } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '../store/useStore'
import { useSim } from '../sim/runtime'

const item = 'flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-line/10 disabled:pointer-events-none disabled:opacity-35'

/** Right-click menu for a component. */
export function ContextMenu() {
  const ctx = useStore((s) => s.ctx)
  const comp = useStore((s) => s.architecture.components.find((c) => c.id === s.ctx?.id))
  const ctxId = ctx?.id
  const fault = useSim((s) => (ctxId ? s.injected[ctxId] : undefined))

  useEffect(() => {
    if (!ctx) return
    const close = () => useStore.getState().closeCtx()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', onKey) }
  }, [ctx])

  if (!ctx || !comp) return null
  const { inject, restore } = useSim.getState()
  const st = useStore.getState()
  const run = (fn: () => void) => () => { fn(); st.closeCtx() }
  const canLose = comp.kind === 'appServers' && (comp.config.instances ?? 1) > 1
  const w = 200
  const x = Math.min(ctx.x, window.innerWidth - w - 8)
  const y = Math.min(ctx.y, window.innerHeight - 260)
  return (
    <div className="panel fixed z-50 p-1 shadow-lg shadow-line/10" style={{ left: x, top: y, width: w }} onPointerDown={(e) => e.stopPropagation()} role="menu" aria-label={`${comp.name} actions`}>
      <div className="label px-2.5 py-1.5">{comp.name}</div>
      {comp.kind !== 'client' && (
        <>
          <button role="menuitem" className={item} onClick={run(() => inject(comp.id, 'killed'))} disabled={fault === 'killed'}><Skull size={14} /> Kill</button>
          <button role="menuitem" className={item} onClick={run(() => inject(comp.id, 'slow'))} disabled={fault === 'slow'}><Snail size={14} /> Slow down</button>
          {canLose && <button role="menuitem" className={item} onClick={run(() => inject(comp.id, 'lostInstance'))} disabled={fault === 'lostInstance'}><Minus size={14} /> Lose one instance</button>}
          <button role="menuitem" className={item} onClick={run(() => restore(comp.id))} disabled={!fault}><RotateCcw size={14} /> Restore</button>
          <div className="my-1 h-px bg-line/10" />
        </>
      )}
      <button role="menuitem" className={item} onClick={run(() => st.duplicateComponent(comp.id))}><Copy size={14} /> Duplicate</button>
      <button role="menuitem" className={`${item} text-failed`} onClick={run(() => { st.removeComponent(comp.id); toast(`Removed ${comp.name}`, { action: { label: 'Undo', onClick: () => useStore.getState().undo() } }) })}><Trash2 size={14} /> Delete</button>
    </div>
  )
}
