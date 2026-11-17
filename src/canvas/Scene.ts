import { Application, Container, Graphics, Rectangle, type FederatedPointerEvent } from 'pixi.js'
import { Viewport } from 'pixi-viewport'
import { gridToScreen, screenToGrid, screenToGridF, footprint, distToSegment, type Pt } from '../lib/iso'
import { theme, type Theme } from '../lib/theme'
import { canPlace, FOOT } from '../store/arch'
import type { Architecture, ComponentKind } from '../store/types'
import { ComponentView } from './ComponentView'
import { lookKey } from './tier'
import { connectionPts, isoPath } from './drawing'
import { EdgeLabels } from './EdgeLabels'
import { Particles, makePath, type Path } from './Particles'
import { live } from '../sim/runtime'
import { useTrace } from '../sim/traceStore'
import { TracePlayer } from './TracePlayer'

type Cell = { col: number; row: number }

export interface SceneHandlers {
  onSelect: (id: string | null) => void
  onSelectConn: (id: string | null) => void
  onHover: (cell: Cell | null) => void
  onHoverComp: (id: string | null) => void
  onContextMenu: (id: string, clientX: number, clientY: number) => void
  onMove: (id: string, col: number, row: number) => void
  onConnect: (from: string, to: string) => void
  onConnectMode: (on: boolean) => void
  /** The user Shift-clicked a moving dot on this connection: trace a request that travels over it. */
  onTrace: (edgeId: string) => void
}

/** Grab radius of the connect handle, in screen pixels. */
const HANDLE_PICK_PX = 20

interface DragState { id: string; view: ComponentView; grab: Pt; start: Cell; moved: boolean; cur: Cell; valid: boolean }
interface ConnectState { from: string; target: string | null; sticky: boolean; press: Pt }
interface Ripple { g: Graphics; age: number }

/** How far (screen pixels) from a connection line a click still counts as on it. */
const CONN_HIT_PX = 16

export class Scene {
  insets: () => { leftOpen: boolean; rightOpen: boolean } = () => ({ leftOpen: true, rightOpen: true })
  app!: Application
  viewport!: Viewport
  private t!: Theme
  private host: HTMLElement
  private h: SceneHandlers
  private edgeLabels!: EdgeLabels
  private arch: Architecture = { name: '', components: [], connections: [] }
  private views = new Map<string, ComponentView>()
  private world = new Container()
  private conns = new Graphics()
  private preview = new Graphics()
  private hover = new Graphics()
  private ghost: ComponentView | null = null
  private ghostKind: ComponentKind | null = null
  private selId: string | null = null
  private selConn: string | null = null
  private drag: DragState | null = null
  private connect: ConnectState | null = null
  private ripples: Ripple[] = []
  private known = new Set<string>()
  /** True when the current press began on a component, so the follow-up click must not deselect. */
  private downOnComp = false
  private hoverId: string | null = null
  private tipTimer = 0
  private swallowUp = false
  private handleLayer = new Container()
  private paths = new Map<string, Path>()
  private particles!: Particles
  private player!: TracePlayer
  private destroyed = false
  ready = false

  constructor(host: HTMLElement, h: SceneHandlers) {
    this.host = host
    this.h = h
  }

  async init() {
    this.t = theme()
    await Promise.all([document.fonts.load('10px "IBM Plex Mono"'), document.fonts.load('500 10px "IBM Plex Mono"')])
    const app = new Application()
    await app.init({ resizeTo: this.host, background: this.t.bg, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true })
    if (this.destroyed) { app.destroy(true, true); return }
    this.app = app
    this.host.appendChild(app.canvas)

    const vp = new Viewport({ screenWidth: this.host.clientWidth, screenHeight: this.host.clientHeight, events: app.renderer.events })
    this.viewport = vp
    app.stage.addChild(vp)
    vp.drag().pinch().wheel({ smooth: 8 }).decelerate({ friction: 0.92 }).clampZoom({ minScale: 0.35, maxScale: 2.5 })
    app.renderer.on('resize', (w, h) => vp.resize(w, h))

    vp.addChild(this.buildGrid())
    this.world.sortableChildren = true
    this.conns.zIndex = -1000
    this.world.addChild(this.conns)
    this.particles = new Particles(this.t)
    this.edgeLabels = new EdgeLabels(this.t)
    this.particles.g.zIndex = -900 // above connection lines, below components so traffic flows "into" them
    this.world.addChild(this.particles.g)
    this.edgeLabels.zIndex = -850
    this.world.addChild(this.edgeLabels)
    vp.addChild(this.world)
    this.player = new TracePlayer(this.t)
    vp.addChild(this.player.g) // the traced request rides above the components
    vp.addChild(this.handleLayer) // connect handles live above every component
    vp.addChild(this.hover, this.preview)

    // Everything about "what is under the cursor" is decided by geometry (componentAt, handleUnder), in the capture
    // phase, so Pixi's hit test (which rejects parts of a shape) is never consulted for presses.
    vp.on('pointerdowncapture', (e) => this.onPress(e))
    // Pixi skips capture listeners when the viewport itself is the target (it thinks the spot is empty), so run the
    // same logic there too. onPress ignores a press it has already seen.
    vp.on('pointerdown', (e) => this.onPress(e))
    vp.on('rightclick', (e) => {
      const id = this.componentAt(this.viewport.toWorld(e.global))
      if (id) { e.stopPropagation(); this.h.onContextMenu(id, e.client.x, e.client.y) }
    })
    vp.on('clicked', (e) => this.onClicked(e.world, !!(e.event as FederatedPointerEvent).shiftKey))
    vp.on('pointermove', (e) => this.onMove(e))
    vp.on('pointerup', (e) => this.onUp(e))
    vp.on('pointerupoutside', (e) => this.onUp(e))
    vp.on('pointerleave', () => { this.hover.clear(); this.h.onHover(null); this.setHoverComp(null) })
    app.canvas.addEventListener('pointerleave', () => this.setHoverComp(null))

    app.ticker.add(() => {
      const res = live.result
      const inv = 1 / Math.min(2.2, Math.max(0.45, this.viewport.scale.x)) // keeps the connect handle the same size on screen at any zoom
      this.views.forEach((v, id) => { v.setNode(res?.nodes[id]); v.setBottleneck(id === live.bottleneck); v.handle.scale.set(inv); v.tick() })
      this.ghost?.tick()
      this.player.update(useTrace.getState(), this.paths, this.arch)
      this.edgeLabels.update(this.arch, this.paths, res)
      this.particles.update(Math.min(0.05, app.ticker.deltaMS / 1000), this.paths, res, live.running, live.speed)
      this.tickRipples()
    })
    this.ready = true
  }

  // ---------- architecture sync ----------

  setArchitecture(arch: Architecture, animate = true) {
    this.arch = arch
    const ids = new Set(arch.components.map((c) => c.id))
    for (const k of this.known) if (!ids.has(k)) this.known.delete(k)
    for (const [id, v] of this.views) {
      const c = arch.components.find((x) => x.id === id)
      if (!c || c.name !== v.comp.name || c.kind !== v.comp.kind || lookKey(c) !== lookKey(v.comp) || c.position.col !== v.comp.position.col || c.position.row !== v.comp.position.row) {
        if (id === this.hoverId) { this.hoverId = null; this.h.onHoverComp(null) }
        this.handleLayer.removeChild(v.handle)
        v.handle.destroy()
        this.world.removeChild(v)
        v.destroy({ children: true })
        this.views.delete(id)
      } else v.comp = c
    }
    for (const c of arch.components) {
      if (this.views.has(c.id)) continue
      const v = new ComponentView(c, this.t)
      v.zIndex = c.position.col + c.position.row
      this.handleLayer.addChild(v.handle)
      if (animate && !this.known.has(c.id)) v.appear()
      this.known.add(c.id)
      this.views.set(c.id, v)
      this.world.addChild(v)
    }
    this.setSelected(this.selId)
    this.redrawConnections()
  }

  setSelected(id: string | null) {
    this.selId = id
    this.views.forEach((v, k) => v.setSelected(k === id))
  }

  setSelectedConn(id: string | null) {
    this.selConn = id
    this.redrawConnections()
  }

  // ---------- camera ----------

  fit(animate = true) {
    const comps = this.arch.components
    if (!comps.length || !this.viewport) return
    const pts = comps.flatMap((c) => footprint(c.position.col, c.position.row, 2, 2))
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + 30
    const w = this.host.clientWidth, hgt = this.host.clientHeight
    const wide = w >= 768
    const { leftOpen, rightOpen } = this.insets()
    const left = wide && leftOpen ? 210 : 0, right = wide && rightOpen ? 260 : 0
    const freeW = w - left - right - 80, freeH = hgt - 64 - 100 - 80
    const scale = Math.min(1.4, Math.min(freeW / Math.max(1, maxX - minX), freeH / Math.max(1, maxY - minY)))
    const freeCx = left + (w - left - right) / 2
    const center = { x: (minX + maxX) / 2 + (w / 2 - freeCx) / scale, y: (minY + maxY) / 2 + (hgt / 2 - (64 + (hgt - 64 - 100) / 2)) / scale }
    if (animate) this.viewport.animate({ position: center, scale, time: 500, ease: 'easeInOutSine' })
    else { this.viewport.setZoom(scale, true); this.viewport.moveCenter(center.x, center.y) }
  }

  zoomBy(f: number) {
    this.viewport.animate({ scale: Math.min(2.5, Math.max(0.35, this.viewport.scale.x * f)), time: 200, ease: 'easeOutQuad' })
  }

  /** Grid cell for a screen-space client point, centred so a 2×2 footprint sits under the cursor. */
  cellFromClient(clientX: number, clientY: number): Cell {
    const r = this.host.getBoundingClientRect()
    const p = this.viewport.toWorld(clientX - r.left, clientY - r.top)
    const g = screenToGridF(p.x, p.y)
    return { col: Math.round(g.col) - 1, row: Math.round(g.row) - 1 }
  }

  viewCenterCell(): Cell {
    const c = this.viewport.center
    const g = screenToGridF(c.x, c.y)
    return { col: Math.round(g.col) - 1, row: Math.round(g.row) - 1 }
  }

  // ---------- palette ghost ----------

  showGhost(kind: ComponentKind, cell: Cell) {
    if (this.ghostKind !== kind) {
      this.hideGhost()
      this.ghost = new ComponentView({ id: 'ghost', kind, name: '', position: { col: 0, row: 0 }, config: {} }, this.t)
      this.ghost.alpha = 0.6
      this.ghost.eventMode = 'none'
      this.ghost.zIndex = 9999
      this.ghostKind = kind
      this.world.addChild(this.ghost)
    }
    const o = gridToScreen(cell.col, cell.row)
    this.ghost!.position.set(o.x, o.y)
    this.ghost!.setInvalid(!canPlace(this.arch, cell.col, cell.row))
    this.drawHover(cell.col, cell.row, FOOT)
  }

  hideGhost() {
    if (this.ghost) { this.world.removeChild(this.ghost); this.ghost.destroy({ children: true }) }
    this.ghost = null
    this.ghostKind = null
    this.hover.clear()
  }

  ripple(cell: Cell) {
    const g = new Graphics()
    this.world.addChild(g)
    g.zIndex = -500
    const c = gridToScreen(cell.col + 1, cell.row + 1)
    g.position.set(c.x, c.y)
    this.ripples.push({ g, age: 0 })
  }

  private tickRipples() {
    for (const r of this.ripples) {
      r.age += 0.04
      const k = r.age, rx = 40 + k * 90, ry = rx / 2
      r.g.clear().ellipse(0, 0, rx, ry).stroke({ width: 1.5, color: this.t.accent, alpha: Math.max(0, 0.7 * (1 - k)) })
    }
    this.ripples = this.ripples.filter((r) => {
      if (r.age < 1) return true
      this.world.removeChild(r.g)
      r.g.destroy()
      return false
    })
  }

  // ---------- pointer interaction ----------

  /**
   * The selected component whose connect handle is under this screen point. Plain geometry, not Pixi's hit test:
   * the whole disc (20 px on screen at any zoom) is grabbable, whatever is drawn underneath it.
   */
  private handleUnder(global: Pt): string | null {
    const id = this.selId
    const v = id ? this.views.get(id) : undefined
    if (!id || !v || !v.handle.visible) return null
    const w = this.viewport.toWorld(global)
    const k = this.viewport.scale.x
    return Math.hypot((w.x - v.handle.position.x) * k, (w.y - v.handle.position.y) * k) <= HANDLE_PICK_PX ? id : null
  }

  /** The topmost component whose area contains this world point, or null. */
  private componentAt(world: Pt): string | null {
    let best: ComponentView | null = null
    for (const v of this.views.values()) {
      if (!v.containsWorld(world.x, world.y)) continue
      if (!best || v.zIndex >= best.zIndex) best = v
    }
    return best ? best.comp.id : null
  }

  /** The browser event of the press last handled. (Not Pixi's event object: Pixi recycles those between presses.) */
  private lastPress: unknown = null

  private onPress(e: FederatedPointerEvent) {
    if (e.button !== 0 || e.nativeEvent === this.lastPress) return
    this.lastPress = e.nativeEvent
    const handleId = this.handleUnder(e.global)
    if (handleId) {
      e.stopPropagation()
      if (this.connect?.sticky) { this.cancelConnect(); this.swallowUp = true; this.downOnComp = true; return }
      this.beginConnect(handleId, e)
      return
    }
    const world = this.viewport.toWorld(e.global)
    if (this.connect?.sticky) {
      // second click of click-then-click: the component under the cursor is the target
      e.stopPropagation()
      this.resolveSticky(this.connect.target ?? this.componentAt(world))
      return
    }
    const id = this.componentAt(world)
    if (id) {
      e.stopPropagation()
      this.downOnComp = true // the press already selected it; the click that follows must not deselect
      this.beginDrag(id, this.views.get(id)!, e)
      return
    }
    this.downOnComp = false
  }

  private setHoverComp(id: string | null) {
    if (id === this.hoverId) return
    const prev = this.hoverId
    this.hoverId = id
    if (prev) this.views.get(prev)?.setHover(false)
    if (id) this.views.get(id)?.setHover(true)
    if (this.connect) {
      const from = this.connect.from
      if (prev && prev !== from) this.views.get(prev)?.setLink('candidate')
      if (id && id !== from) this.views.get(id)?.setLink('target')
      this.connect.target = id && id !== from ? id : null
    }
    if (id) { this.hover.clear(); this.h.onHover(null) }
    // tooltip: appears at once, hides after a short grace so a brief gap can't make it flicker
    window.clearTimeout(this.tipTimer)
    if (id && !this.connect) this.h.onHoverComp(id)
    else this.tipTimer = window.setTimeout(() => this.h.onHoverComp(null), 120)
  }

  private beginDrag(id: string, view: ComponentView, e: FederatedPointerEvent) {
    if (e.button !== 0 || this.connect || this.handleUnder(e.global)) return
    this.h.onSelect(id)
    this.setHoverComp(null)
    view.handle.visible = false
    const c = view.comp
    this.drag = { id, view, grab: this.viewport.toWorld(e.global), start: { ...c.position }, moved: false, cur: { ...c.position }, valid: true }
    this.viewport.plugins.pause('drag')
  }

  private beginConnect(from: string, e: FederatedPointerEvent) {
    this.downOnComp = true
    this.h.onHoverComp(null) // no tooltips while picking a target
    this.views.get(from)?.setHandleState('active')
    this.viewport.cursor = 'crosshair'
    this.connect = { from, target: null, sticky: false, press: { x: e.global.x, y: e.global.y } }
    this.viewport.plugins.pause('drag')
    this.views.forEach((v, id) => v.setLink(id === from ? 'none' : 'candidate'))
  }

  /** Esc / click-away: leave connect mode. Returns true if there was a connection in progress. */
  cancelConnect(): boolean {
    if (!this.connect) return false
    this.endConnect()
    return true
  }

  /** Second click of click-then-click connecting. */
  private resolveSticky(to: string | null) {
    const from = this.connect!.from
    this.endConnect()
    this.swallowUp = true // the release that follows this press must not do anything
    this.downOnComp = true // …and the click must not deselect
    if (to && to !== from) this.h.onConnect(from, to)
  }

  private endConnect() {
    const wasSticky = this.connect?.sticky
    const fromId = this.connect?.from
    this.connect = null
    if (wasSticky) this.h.onConnectMode(false)
    if (fromId) this.views.get(fromId)?.setHandleState('idle')
    this.viewport.cursor = 'default'
    this.preview.clear()
    this.views.forEach((v) => v.setLink('none'))
    this.viewport.plugins.resume('drag')
  }

  private onMove(e: FederatedPointerEvent) {
    const p = this.viewport.toWorld(e.global)
    const cell = screenToGrid(p.x, p.y)
    // What is under the cursor right now? Decided on every move from the event's own hit target.
    if (!this.drag) this.setHoverComp(this.componentAt(p))
    // The ground-cell highlight is only for empty ground; over a component it would read as hovering the squares.
    if (!this.drag && !this.ghost && !this.hoverId) this.drawHover(cell.col, cell.row, 1)
    this.h.onHover(this.hoverId ? null : cell)
    // moving dots can be clicked to trace that request: say so with the cursor
    if (!this.drag && !this.connect) {
      const overHandle = this.handleUnder(e.global)
      if (overHandle) {
        this.setHoverComp(null) // no tooltip or ground highlight while aiming at the handle
        this.hover.clear()
        this.h.onHover(null)
        this.app.renderer.events.rootBoundary.cursor = 'crosshair' // Pixi applies this after our handler runs
      }
      this.views.forEach((v, id) => v.setHandleState(id === overHandle ? 'hover' : 'idle'))
      this.viewport.cursor = !overHandle && !this.hoverId && ((e.shiftKey && this.particles.hit(p, 8 / this.viewport.scale.x)) || this.connAt(p)) ? 'pointer' : 'default'
    }

    const d = this.drag
    if (d) {
      const dx = p.x - d.grab.x, dy = p.y - d.grab.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      const g = screenToGridF(dx, dy)
      d.cur = { col: d.start.col + Math.round(g.col), row: d.start.row + Math.round(g.row) }
      d.valid = canPlace(this.arch, d.cur.col, d.cur.row, d.id)
      const a = gridToScreen(d.start.col, d.start.row), b = gridToScreen(d.cur.col, d.cur.row)
      d.view.position.set(b.x - a.x, b.y - a.y)
      d.view.zIndex = 9000
      d.view.setInvalid(!d.valid)
      this.drawHover(d.cur.col, d.cur.row, FOOT)
      this.redrawConnections({ [d.id]: d.cur })
      return
    }

    if (this.connect) this.drawConnector(p)
  }

  /**
   * The live connector while dragging from the handle: a dashed line that follows the cursor, which snaps into
   * the exact route the real connection will take once the cursor is over a valid target.
   */
  private drawConnector(cursor: Pt) {
    const c = this.connect!
    const from = this.arch.components.find((x) => x.id === c.from)
    const fromView = this.views.get(c.from)
    const g = this.preview.clear()
    if (!from || !fromView) return
    const accent = this.t.accent
    const target = c.target ? this.arch.components.find((x) => x.id === c.target) : null
    if (target) {
      const pts = connectionPts(from.position, target.position)
      isoPath(g, pts)
      g.stroke({ width: 8, color: accent, alpha: 0.16, cap: 'round', join: 'round' })
      isoPath(g, pts)
      g.stroke({ width: 2.5, color: accent, cap: 'round', join: 'round' })
      const end = pts[2], prev = pts[1].x === end.x && pts[1].y === end.y ? pts[0] : pts[1]
      const ang = Math.atan2(end.y - prev.y, end.x - prev.x)
      const tip = { x: end.x - Math.cos(ang) * 40, y: end.y - Math.sin(ang) * 20 }
      g.poly([tip.x, tip.y, tip.x - Math.cos(ang - 0.5) * 9, tip.y - Math.sin(ang - 0.5) * 9, tip.x - Math.cos(ang + 0.5) * 9, tip.y - Math.sin(ang + 0.5) * 9]).fill({ color: accent })
      return
    }
    // free end: dashed line from the handle to the cursor, with a ring where it will land
    const a = { x: fromView.handle.position.x, y: fromView.handle.position.y }
    const dx = cursor.x - a.x, dy = cursor.y - a.y
    const len = Math.hypot(dx, dy)
    const ux = dx / Math.max(1, len), uy = dy / Math.max(1, len)
    for (let d = 12; d < len - 6; d += 10) g.moveTo(a.x + ux * d, a.y + uy * d).lineTo(a.x + ux * Math.min(d + 5, len - 6), a.y + uy * Math.min(d + 5, len - 6))
    g.stroke({ width: 2, color: accent, alpha: 0.95, cap: 'round' })
    g.circle(cursor.x, cursor.y, 7).stroke({ width: 1.5, color: accent, alpha: 0.8 })
    g.circle(cursor.x, cursor.y, 2.5).fill({ color: accent })
  }

  private onUp(e?: FederatedPointerEvent) {
    if (this.swallowUp) { this.swallowUp = false; return }
    const d = this.drag
    if (d) {
      this.drag = null
      this.viewport.plugins.resume('drag')
      this.hover.clear()
      d.view.handle.visible = d.view.isSelected
      if (d.moved && d.valid && (d.cur.col !== d.start.col || d.cur.row !== d.start.row)) {
        this.h.onMove(d.id, d.cur.col, d.cur.row)
      } else if (d.view.parent) {
        d.view.position.set(0, 0)
        d.view.setInvalid(false)
        d.view.zIndex = d.view.comp.position.col + d.view.comp.position.row
        this.redrawConnections()
      }
    }
    if (this.connect) {
      // Pixi doesn't route pointerup to the drop target when the press began on the handle, so the drop is decided here.
      const c = this.connect
      if (c.sticky) return
      const moved = e ? Math.hypot(e.global.x - c.press.x, e.global.y - c.press.y) > 6 : true
      const under = e ? this.componentAt(this.viewport.toWorld(e.global)) : c.target
      if ((!under || under === c.from) && !moved) {
        // a plain click on the handle: stay in connect mode until the next click picks the target
        c.sticky = true
        this.h.onConnectMode(true)
        return
      }
      // Decide the drop from where the pointer is at the moment of release, not from the last hover, which can be stale.
      const target = e ? this.componentAt(this.viewport.toWorld(e.global)) : c.target
      const from = c.from
      this.endConnect()
      if (target && target !== from) this.h.onConnect(from, target)
    }
  }

  /** The connection nearest to a point, within a generous margin either side of the line so it is easy to hit. */
  private connAt(world: Pt): string | null {
    const tol = CONN_HIT_PX / this.viewport.scale.x
    let best: string | null = null, bestD = tol
    for (const cn of this.arch.connections) {
      const a = this.arch.components.find((c) => c.id === cn.from), b = this.arch.components.find((c) => c.id === cn.to)
      if (!a || !b) continue
      const pts = connectionPts(a.position, b.position)
      const d = Math.min(distToSegment(world, pts[0], pts[1]), distToSegment(world, pts[1], pts[2]))
      if (d < bestD) { bestD = d; best = cn.id }
    }
    return best
  }

  private onClicked(world: Pt, shift: boolean) {
    // a press that began on a component already selected it; don't let the click deselect
    if (this.downOnComp) { this.downOnComp = false; return }
    // tracing a request needs Shift, so a plain click on a busy line always selects the connection
    const edge = shift ? this.particles.hit(world, 8 / this.viewport.scale.x) : null
    if (edge) { this.h.onTrace(edge); return }
    const hit = this.connAt(world)
    if (hit) { this.h.onSelectConn(hit); return }
    this.h.onSelect(null)
  }

  // ---------- drawing ----------

  private buildGrid() {
    const g = new Graphics()
    const N = 28
    for (let i = -N; i <= N; i++) {
      const major = i % 5 === 0
      const style = { width: 1, color: this.t.grid, alpha: major ? 0.3 : 0.14 }
      const a = gridToScreen(i, -N), b = gridToScreen(i, N)
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke(style)
      const c = gridToScreen(-N, i), d = gridToScreen(N, i)
      g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke(style)
    }
    for (let i = 0; i <= 12; i++) {
      const p = gridToScreen(i, -0.4)
      g.moveTo(p.x, p.y).lineTo(p.x + 3, p.y - 1.5).stroke({ width: 1, color: this.t.dim, alpha: 0.5 })
    }
    return g
  }

  private redrawConnections(override: Record<string, Cell> = {}) {
    const g = this.conns.clear()
    this.paths.clear()
    const pos = (id: string) => override[id] ?? this.arch.components.find((c) => c.id === id)?.position
    for (const cn of this.arch.connections) {
      const a = pos(cn.from), b = pos(cn.to)
      if (!a || !b) continue
      const sel = cn.id === this.selConn
      const color = sel ? this.t.accent : this.t.line
      const pts = connectionPts(a, b)
      this.paths.set(cn.id, makePath(pts))
      isoPath(g, pts)
      g.stroke({ width: sel ? 7 : 4, color, alpha: sel ? 0.18 : 0.07 })
      isoPath(g, pts)
      g.stroke({ width: sel ? 2 : 1, color, alpha: sel ? 1 : 0.55 })
      const end = pts[2], prev = pts[1].x === end.x && pts[1].y === end.y ? pts[0] : pts[1]
      const ang = Math.atan2(end.y - prev.y, end.x - prev.x)
      const tip = { x: end.x - Math.cos(ang) * 40, y: end.y - Math.sin(ang) * 20 }
      g.poly([tip.x, tip.y, tip.x - Math.cos(ang - 0.5) * 8, tip.y - Math.sin(ang - 0.5) * 8, tip.x - Math.cos(ang + 0.5) * 8, tip.y - Math.sin(ang + 0.5) * 8]).fill({ color, alpha: sel ? 1 : 0.7 })
    }
  }

  private drawHover(col: number, row: number, size: number) {
    const [t, r, b, l] = footprint(col, row, size, size)
    const bad = size > 1 && !canPlace(this.arch, col, row, this.drag?.id)
    const color = bad ? this.t.failed : this.t.accent
    this.hover.clear().poly([t.x, t.y, r.x, r.y, b.x, b.y, l.x, l.y]).fill({ color, alpha: bad ? 0.12 : 0.08 }).stroke({ width: 1, color, alpha: 0.5 })
  }

  /** Renders what is on screen (components, traffic, labels) at 2× to a PNG data URL, on the paper background. */
  async exportPng(): Promise<string> {
    this.hover.clear()
    this.preview.clear()
    const { app } = this
    return app.renderer.extract.base64({ target: app.stage, frame: new Rectangle(0, 0, app.screen.width, app.screen.height), resolution: 2, clearColor: this.t.bg })
  }

  destroy() {
    this.destroyed = true
    window.clearTimeout(this.tipTimer)
    if (this.app) this.app.destroy(true, { children: true })
  }
}
