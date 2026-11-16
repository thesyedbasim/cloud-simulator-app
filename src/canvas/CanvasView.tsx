import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Scene } from './Scene'
import { useStore } from '../store/useStore'
import { useTrace } from '../sim/traceStore'
import { canPlace } from '../store/arch'
import { KIND_INFO, type ComponentKind } from '../store/types'

export const sceneRef: { current: Scene | null } = { current: null }

const CONNECT_MSG = { self: "A component can't connect to itself", duplicate: 'Already connected', reverse: 'Already connected the other way' } as const

export function CanvasView() {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const st = useStore.getState
    const scene = new Scene(host.current!, {
      onSelect: (id) => st().select(id),
      onSelectConn: (id) => st().selectConn(id),
      onHover: (c) => st().setHoverCell(c),
      onHoverComp: (id) => st().setHoverId(id),
      onContextMenu: (id, x, y) => st().openCtx(id, x, y),
      onMove: (id, col, row) => st().moveComponent(id, col, row),
      onTrace: (edgeId) => useTrace.getState().start(edgeId),
      onConnectMode: (on) => {
        if (on) toast('Click a component to connect to', { id: 'connect-hint', description: 'Press Esc to cancel', duration: Infinity })
        else toast.dismiss('connect-hint')
      },
      onConnect: (from, to) => {
        const r = st().addConnection(from, to)
        if (r !== 'ok') toast(CONNECT_MSG[r])
      },
    })
    sceneRef.current = scene
    scene.insets = () => st()
    let unsub = () => {}
    let cancelled = false
    scene.init().then(() => {
      if (cancelled) return
      const s = st()
      scene.setArchitecture(s.architecture, false)
      scene.setSelected(s.selectedId)
      scene.setSelectedConn(s.selectedConnId)
      scene.fit(false)
      unsub = useStore.subscribe((s, prev) => {
        if (s.architecture !== prev.architecture) scene.setArchitecture(s.architecture)
        if (s.selectedId !== prev.selectedId) scene.setSelected(s.selectedId)
        if (s.selectedConnId !== prev.selectedConnId) scene.setSelectedConn(s.selectedConnId)
      })
    })
    return () => { cancelled = true; unsub(); scene.destroy(); sceneRef.current = null }
  }, [])

  const onDragOver = (e: React.DragEvent) => {
    const kind = useStore.getState().dragKind
    const scene = sceneRef.current
    if (!kind || !scene?.ready) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    scene.showGhost(kind, scene.cellFromClient(e.clientX, e.clientY))
  }

  const onDrop = (e: React.DragEvent) => {
    const { dragKind, architecture, addComponent, setDragKind } = useStore.getState()
    const scene = sceneRef.current
    if (!dragKind || !scene) return
    e.preventDefault()
    scene.hideGhost()
    const cell = scene.cellFromClient(e.clientX, e.clientY)
    setDragKind(null)
    if (!canPlace(architecture, cell.col, cell.row)) { toast("Can't place here", { description: 'That spot overlaps another component.' }); return }
    addComponent(dragKind, cell.col, cell.row)
    scene.ripple(cell)
  }

  return <div ref={host} className="absolute inset-0" onContextMenu={(e) => e.preventDefault()} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => sceneRef.current?.hideGhost()} />
}

/** Add a component at the first free slot near the middle of the view (click-to-add). */
export function addAtCenter(kind: ComponentKind) {
  const scene = sceneRef.current
  const s = useStore.getState()
  if (!scene?.ready) return
  const id = s.addNear(kind, scene.viewCenterCell())
  if (!id) { toast('No free space', { description: 'Zoom out or remove something first.' }); return }
  const c = useStore.getState().architecture.components.find((x) => x.id === id)
  if (c) scene.ripple(c.position)
  toast(`${KIND_INFO[kind].label} added`)
}
