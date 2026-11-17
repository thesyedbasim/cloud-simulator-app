import { Container, Graphics, Polygon, Text } from 'pixi.js'
import { GEO_OFF, geoModeOf, REGIONS, regionOf } from '../sim/geo'
import { gridToScreen, footprint } from '../lib/iso'
import type { Theme } from '../lib/theme'
import { configValue, type ArchComponent } from '../store/types'
import { clientMonitors, levelOf, queueCrates } from './tier'
import { isoBox, isoCylinder, isoTube, isoWire, setPaper, solid } from './drawing'
import type { NodeResult } from '../sim/engine'

/** One drawable object per component. Step 1 draws static linework; Step 3 will add update(simState). */
export class ComponentView extends Container {
  readonly id: string
  comp: ArchComponent
  readonly handle = new Graphics()
  private selected = false
  private link: 'none' | 'candidate' | 'target' = 'none'
  private appearing = false
  private fx = new Graphics() // indicators painted ON the body (LEDs, pool gauge, failure badge): float with it
  private fxStatic = new Graphics() // load bar, queue-depth column: never move
  private fxBelow = new Graphics()
  private stat = new Text({ text: '', style: { fontFamily: 'IBM Plex Mono', fontSize: 8, fill: '#5a7089', letterSpacing: 0.4 } })
  private node: NodeResult | undefined
  private invalid = false
  private reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  private theme: Theme
  private body = new Graphics()
  private ring = new Graphics()
  private nameText!: Text
  private bobAmp = 0
  private hitPoly = new Polygon([])
  private footPoly = new Polygon([])
  private slots = new Graphics() // autoscaling slots: solid = running, amber = starting, outline = headroom
  private isAuto: boolean
  private bottleneck = false
  private tag = new Container()
  private labelHot = false
  private ringFill = new Graphics()
  private hoverGlow = 0
  private target = 0

  constructor(comp: ArchComponent, theme: Theme) {
    super()
    this.comp = comp
    this.theme = theme
    this.isAuto = comp.kind === 'appServers' && (configValue('appServers', comp.config, 'autoscale') ?? 0) >= 0.5
    this.id = comp.id
    this.eventMode = 'static'
    this.cursor = 'pointer'
    const { col, row } = comp.position
    setPaper(theme.bg)
    // selection fill sits under the (opaque) body; its outline and ticks sit on top so they stay visible
    // (the connect handle is NOT a child: the scene keeps it on a top layer so neighbours can't cover it)
    this.addChild(this.fxBelow, this.ringFill, this.body, this.slots, this.ring, this.fx, this.fxStatic)
    this.drawHandle(col, row)
    this.draw(col, row)

    const label = this.nameText = new Text({
      text: comp.name.toUpperCase(),
      style: { fontFamily: 'IBM Plex Mono', fontSize: 10, fill: theme.dim, letterSpacing: 1 },
    })
    label.anchor.set(0.5, 0)
    const bottom = gridToScreen(col + 2, row + 2)
    label.position.set(bottom.x, bottom.y - 0)
    // bottom corner of a 2x2 footprint is (col+2,row+2); sit label just below it
    label.y += 6
    this.addChild(label)
    this.stat.anchor.set(0.5, 0)
    this.addChild(this.stat)
    label.x = gridToScreen(col + 1, row + 1).x
    label.y = gridToScreen(col + 2, row + 2).y + 4
    this.stat.position.set(label.x, label.y + 12)
    this.buildTag(col)
    this.buildHitArea(col, row)
  }

  /** One drawing per kind, and each kind has a visibly different look at every upgrade level (see tier.ts). */
  private draw(col: number, row: number) {
    const g = this.body
    const c = this.theme.line
    const acc = this.theme.accent
    const cfg = this.comp.config
    const L = levelOf(this.comp)
    const x = col + 0.25
    const y = row + 0.25
    switch (this.comp.kind) {
      case 'client': {
        // more traffic, more monitors on the desk
        const n = clientMonitors(configValue('client', cfg, 'rps') ?? 500)
        isoBox(g, col + 0.3, row + 0.3, 1.4, 1.4, 4, c, 0, 0.1)
        const s = n === 1 ? 0.6 : n === 2 ? 0.46 : 0.34
        const step = s + 0.08
        const x0 = col + 0.3 + (1.4 - (n * step - 0.08)) / 2
        const y0 = row + 0.3 + (1.4 - s) / 2
        for (let i = 0; i < n; i++) isoBox(g, x0 + i * step, y0, s, s, n === 1 ? 22 : n === 2 ? 20 : 18, c, 4, 0.2)
        break
      }
      case 'loadBalancer': {
        // Kept simple on purpose: one pipe in, a round hub, one pipe out per target (up to six).
        // Higher levels (more targets) make the hub taller.
        const arms = Math.min(6, configValue('loadBalancer', cfg, 'targets') ?? 2)
        const lift = 5
        const hub = gridToScreen(col + 0.8, row + 1)
        const inlet = gridToScreen(col + 0.1, row + 1)
        // pipes first, hub on top: each pipe starts at the hub's centre, so the hub hides its start and
        // the pipe appears to pass through the wall instead of lying on top of the cylinder
        isoTube(g, [{ x: inlet.x, y: inlet.y - lift }, { x: hub.x, y: hub.y - lift }], c, 0.3, 4)
        for (let i = 0; i < arms; i++) {
          const end = gridToScreen(col + 1.85, row + 0.3 + (arms === 1 ? 0.7 : (i / (arms - 1)) * 1.4))
          isoTube(g, [{ x: hub.x, y: hub.y - lift }, { x: end.x, y: end.y - lift }], c, 0.3, 4)
        }
        isoCylinder(g, hub.x, hub.y, 14, 7, 10 + (L - 1) * 8, c)
        break
      }
      case 'appServers': {
        if (this.isAuto) { isoBox(g, col + 0.1, row + 0.1, 1.8, 1.8, 3, c, 0, 0.1); break } // slots are drawn live on this platform
        // more vCPUs: another server stacked on top
        for (let i = 0; i < L; i++) isoBox(g, x, y, 1.5, 1.5, 12, c, i * 15, 0.16)
        const z = (L - 1) * 15 + 12
        // the biggest tiers get an antenna
        if (L >= 5) {
          const p = gridToScreen(x + 1.1, y + 0.4)
          g.moveTo(p.x, p.y - z).lineTo(p.x, p.y - z - 12 - (L - 5) * 5).stroke({ width: 1.5, color: acc })
          g.circle(p.x, p.y - z - 12 - (L - 5) * 5, 2.4).fill({ color: acc })
        }
        break
      }
      case 'database': {
        const cx = col + 1, cy = row + 1
        const l = gridToScreen(cx, cy)
        // read replicas: smaller copies standing behind the primary, one per replica
        const replicas = Math.round(configValue('database', cfg, 'replicas') ?? 0)
        for (let i = replicas - 1; i >= 0; i--) {
          const p = gridToScreen(col + 1.85, row + 0.15 + i * 0.36)
          isoCylinder(g, p.x, p.y, 10, 5, 16, c)
        }
        // more vCPUs: the cylinder grows taller, one more band per level
        const RX = 25.6, RY = 12.8, HT = 24 + (L - 1) * 14
        const side = solid(c, 0.16), cap = solid(c, 0.06)
        const stroke = { width: 1, color: c, alpha: 0.9 }
        // bottom cap, then the opaque side wall, then the top cap
        g.ellipse(l.x, l.y, RX, RY).fill({ color: side }).stroke(stroke)
        g.rect(l.x - RX, l.y - HT, RX * 2, HT).fill({ color: side })
        g.ellipse(l.x, l.y - HT, RX, RY).fill({ color: side })
        g.moveTo(l.x - RX, l.y).lineTo(l.x - RX, l.y - HT).moveTo(l.x + RX, l.y).lineTo(l.x + RX, l.y - HT).stroke(stroke)
        // front half of the bottom edge and a band every 14px
        const bands = [0]
        for (let lift = 12; lift < HT; lift += 14) bands.push(lift)
        for (const lift of bands) {
          g.moveTo(l.x - RX, l.y - lift)
          for (let k = 1; k <= 24; k++) { const a = Math.PI * (k / 24); g.lineTo(l.x - Math.cos(a) * RX, l.y - lift + Math.sin(a) * RY) }
          g.stroke({ width: 1, color: c, alpha: lift === 0 ? 0.9 : 0.55 })
        }
        g.ellipse(l.x, l.y - HT, RX, RY).fill({ color: cap }).stroke({ width: 1, color: c })
        if (L >= 5) g.ellipse(l.x, l.y - HT, RX * 0.55, RY * 0.55).stroke({ width: 1.5, color: acc, alpha: 0.9 }) // the top tier gets an inlaid ring
        // pool gauge track on the front wall
        g.moveTo(l.x + Math.cos(Math.PI * 0.9) * 8, l.y - 12 + Math.sin(Math.PI * 0.9) * 8).arc(l.x, l.y - 12, 8, Math.PI * 0.9, Math.PI * 2.1).stroke({ width: 2, color: c, alpha: 0.25 })
        break
      }
      case 'cache': {
        // a bigger cache (higher hit rate) has more shelves
        isoBox(g, col + 0.2, row + 0.3, 1.6, 1.4, 6, c, 0, 0.12)
        for (let k = 0; k < L - 1; k++) isoBox(g, col + 0.2, row + 0.3, 1.6, 1.4, 2, c, 10 + k * 12, 0.1)
        break
      }
      case 'serverless': {
        // a lightning bolt on a small pad: code that runs on demand. More memory, a bigger bolt.
        const l = gridToScreen(col + 1, row + 1)
        isoCylinder(g, l.x, l.y, 22, 11, 5, c)
        const k = 0.8 + L * 0.2
        const pts = [[6, -50], [-11, -26], [-1, -26], [-8, -8], [12, -32], [2, -32]].flatMap(([dx, dy]) => [l.x + dx * k, l.y + dy * k - 4])
        g.poly(pts).fill({ color: acc, alpha: 0.9 }).stroke({ width: 1.2, color: c })
        break
      }
      case 'cdn': {
        // an edge site with a globe on top; a higher hit rate makes a bigger globe
        const l = gridToScreen(col + 1, row + 1)
        isoCylinder(g, l.x, l.y, 28, 14, 7, c)
        const r = 9 + L * 2.5
        const top = l.y - 10 - r
        g.circle(l.x, top, r).fill({ color: solid(c, 0.1) }).stroke({ width: 1, color: c, alpha: 0.9 })
        g.ellipse(l.x, top, r * 0.45, r).stroke({ width: 1, color: c, alpha: 0.5 })
        g.ellipse(l.x, top, r, r * 0.35).stroke({ width: 1.2, color: acc, alpha: 0.85 })
        break
      }
      case 'bucket': {
        // a tapered bucket; more stored data makes it taller
        const l = gridToScreen(col + 1, row + 1)
        const H = 20 + L * 6, rb = 17, rt = 24
        const stroke = { width: 1, color: c, alpha: 0.9 }
        g.ellipse(l.x, l.y, rb, rb * 0.5).fill({ color: solid(c, 0.16) }).stroke(stroke)
        g.poly([l.x - rb, l.y, l.x - rt, l.y - H, l.x + rt, l.y - H, l.x + rb, l.y]).fill({ color: solid(c, 0.16) })
        g.moveTo(l.x - rb, l.y).lineTo(l.x - rt, l.y - H).moveTo(l.x + rb, l.y).lineTo(l.x + rt, l.y - H).stroke(stroke)
        g.moveTo(l.x - rb, l.y)
        for (let k = 1; k <= 24; k++) { const a = Math.PI * (k / 24); g.lineTo(l.x - Math.cos(a) * rb, l.y + Math.sin(a) * rb * 0.5) }
        g.stroke(stroke)
        g.ellipse(l.x, l.y - H, rt, rt * 0.5).fill({ color: solid(c, 0.05) }).stroke({ width: 1, color: c })
        g.ellipse(l.x, l.y - H, rt * 0.8, rt * 0.4).stroke({ width: 1, color: acc, alpha: 0.6 })
        break
      }
      case 'gateway': {
        // two pillars and a lintel across the road: every request passes through the gate
        const h = 24 + (L - 1) * 7
        isoBox(g, col + 0.6, row + 0.15, 0.8, 0.4, h, c, 0, 0.18)
        isoBox(g, col + 0.6, row + 1.45, 0.8, 0.4, h, c, 0, 0.18)
        isoBox(g, col + 0.6, row + 0.15, 0.8, 1.7, 6, c, h, 0.12)
        break
      }
      case 'queue': {
        // faster drain: more crates on the conveyor
        const n = queueCrates(configValue('queue', cfg, 'capacity') ?? 400)
        const step = Math.min(0.4, 1.7 / n)
        for (let i = 0; i < n; i++) isoBox(g, col + 0.15 + i * step, row + 0.7, step * 0.88, 0.6, 5 + Math.min(i, 5) * 2, c, 0, 0.18)
        break
      }
    }
  }

  /**
   * Hover/click region = everything the component visually occupies: its drawn body (measured, not guessed),
   * the ground footprint, and the name/stat/load-bar area underneath. Its own child so the connect handle
   * (which sits outside it) stays clickable.
   */
  private buildHitArea(col: number, row: number) {
    const [ft, fr, fb, fl] = footprint(col, row, 2, 2)
    const b = this.body.getLocalBounds()
    const x0 = Math.min(b.minX, fl.x) - 4
    const x1 = Math.max(b.maxX, fr.x) + 4
    // how far the body rises above the ground footprint; the top edge follows the iso diamond, not a box
    // autoscaled tiers draw their slots live above a low platform, so reserve room for them
    const lift = Math.max(this.isAuto ? 30 : 0, ft.y - b.minY) + 4
    const yEnd = fb.y + 46
    const hit = new Graphics()
    // Remembered so the scene can ask "is this point on the component?" with plain geometry (see containsWorld).
    const fp = footprint(col - 0.1, row - 0.1, 2.2, 2.2)
    this.footPoly = new Polygon(fp.flatMap((q) => [q.x, q.y]))
    this.hitPoly = new Polygon([
      x0, fl.y - lift, ft.x, ft.y - lift, x1, fr.y - lift, x1, fr.y,
      fb.x + 52, fb.y, fb.x + 52, yEnd, fb.x - 52, yEnd, fb.x - 52, fb.y, x0, fl.y,
    ])
    hit.hitArea = new Polygon([
      x0, fl.y - lift, ft.x, ft.y - lift, x1, fr.y - lift, x1, fr.y,
      fb.x + 52, fb.y, fb.x + 52, yEnd, fb.x - 52, yEnd, fb.x - 52, fb.y, x0, fl.y,
    ])
    hit.eventMode = 'static'
    this.addChildAt(hit, 0)
  }

  /** Red "BOTTLENECK" pill above the part the explanation card is about. */
  private buildTag(col: number) {
    const b = this.body.getLocalBounds()
    const cx = gridToScreen(col + 1, this.comp.position.row + 1).x
    const w = 74
    const pill = new Graphics().roundRect(-w / 2, -8, w, 15, 7.5).fill({ color: this.theme.failed })
    const label = new Text({ text: 'BOTTLENECK', style: { fontFamily: 'IBM Plex Mono', fontSize: 8.5, fill: '#ffffff', letterSpacing: 0.8, fontWeight: '500' } })
    label.anchor.set(0.5)
    label.position.set(0, -0.5)
    const tip = new Graphics().poly([-4, 7, 4, 7, 0, 12]).fill({ color: this.theme.failed })
    this.tag.addChild(pill, tip, label)
    this.tag.position.set(cx, b.minY - 18)
    this.tag.visible = false
    this.addChild(this.tag)
  }

  /** Show just the drawing (no label, stats or indicators), for the palette. */
  iconOnly() { for (const ch of this.children) ch.visible = ch === this.body }

  setBottleneck(on: boolean) {
    this.bottleneck = on
    this.tag.visible = on
  }

  setSelected(on: boolean) {
    this.selected = on
    this.handle.visible = on
    this.refreshRing()
  }

  /** While drawing a connection: 'candidate' = valid target, 'target' = currently hovered. */
  setLink(mode: 'none' | 'candidate' | 'target') {
    this.link = mode
    this.refreshRing()
  }

  setInvalid(bad: boolean) {
    this.invalid = bad
  }

  /** Driven by the scene's pointer-move tracking (not enter/leave events, which flicker between child objects). */
  setHover(on: boolean) {
    this.target = on ? 1 : 0
  }

  setNode(n: NodeResult | undefined) {
    this.node = n
  }

  /** Fade + slight rise on first appearance. */
  appear() {
    this.alpha = 0
    this.appearing = true
  }

  private handleState: 'idle' | 'hover' | 'active' = 'idle'

  /**
   * The connect handle. Drawn in local units around (0,0) and scaled by the scene so it keeps the same size on
   * screen at every zoom; the hit area is much bigger than what is drawn so it is easy to grab.
   */
  private drawHandle(col: number, row: number) {
    const p = gridToScreen(col + 2, row + 1)
    const g = this.handle
    g.position.set(p.x + 14, p.y + 7)
    g.eventMode = 'none' // hit-tested by the scene with plain geometry, which is more reliable (see Scene.handleUnder)
    g.visible = false
    this.paintHandle()
  }

  /** idle: outlined; hover: filled and a little larger; active (being dragged): filled with a halo. */
  setHandleState(state: 'idle' | 'hover' | 'active') {
    if (state === this.handleState) return
    this.handleState = state
    this.paintHandle()
  }

  private paintHandle() {
    const g = this.handle
    const acc = this.theme.accent
    const st = this.handleState
    g.clear()
    if (st === 'active') g.circle(0, 0, 17).fill({ color: acc, alpha: 0.18 })
    else if (st === 'hover') g.circle(0, 0, 15).fill({ color: acc, alpha: 0.12 })
    g.circle(0, 0, 10).fill({ color: st === 'idle' ? this.theme.bg : acc }).stroke({ width: 2, color: acc })
    const ink = st === 'idle' ? acc : 0xffffff
    g.moveTo(-4.5, 0).lineTo(4.5, 0).moveTo(0, -4.5).lineTo(0, 4.5).stroke({ width: 2, color: ink })
  }

  private refreshRing() {
    const g = this.ring.clear()
    const fill = this.ringFill.clear()
    if (!this.selected && this.link === 'none') return
    const [t, r, b, l] = footprint(this.comp.position.col - 0.1, this.comp.position.row - 0.1, 2.2, 2.2)
    const col = this.theme.accent
    const strong = this.selected || this.link === 'target'
    fill.poly([t.x, t.y, r.x, r.y, b.x, b.y, l.x, l.y]).fill({ color: col, alpha: this.link === 'target' ? 0.2 : 0.08 })
    g.poly([t.x, t.y, r.x, r.y, b.x, b.y, l.x, l.y]).stroke({ width: 1, color: col, alpha: strong ? 0.7 : 0.35 })
    if (!strong) return
    // drafting-style corner ticks
    for (const [p, dx, dy] of [[t, 0, 1], [r, -1, 0.5], [b, 0, -1], [l, 1, 0.5]] as const) {
      g.moveTo(p.x - dx * 10, p.y - dy * 5 - 6).lineTo(p.x, p.y).lineTo(p.x + dx * 10, p.y + dy * 5 - 6).stroke({ width: 2, color: col })
    }
  }

  /**
   * Is this world point on the component? Its whole footprint (a little padded) or anywhere on its drawn body,
   * name and load bar. Done with plain geometry rather than Pixi's hit test, so the entire area always counts.
   */
  containsWorld(wx: number, wy: number): boolean {
    const x = wx - this.x, y = wy - this.y
    return this.footPoly.contains(x, y) || this.hitPoly.contains(x, y)
  }

  get isSelected() {
    return this.selected
  }

  /** Smooth hover brighten and the selected bob; called each frame. */
  tick() {
    this.hoverGlow += (this.target - this.hoverGlow) * 0.2
    // Selected = alive: only the component itself (plus what is painted on it) floats ~5px and settles back, forever.
    // Ground ring, label, stat text, load bar and the queue-depth column stay put.
    this.bobAmp += ((this.selected && !this.reduced ? 1 : 0) - this.bobAmp) * 0.12
    const lift = this.bobAmp > 0.002 ? -2.5 * (1 - Math.cos((performance.now() / 1800) * Math.PI * 2)) * this.bobAmp : 0
    this.body.y = lift
    this.slots.y = lift
    this.fx.y = lift
    this.body.alpha = 1
    this.drawState(performance.now())
    if (this.appearing) { this.alpha = Math.min(1, this.alpha + 0.07); if (this.alpha >= 1) this.appearing = false }
    this.body.scale.set(1 + this.hoverGlow * 0.0)
  }

  /** On-object state: status ring, load bar, per-kind gauges, an X badge when failed. */
  private drawState(now: number) {
    const n = this.node
    const fx = this.fx.clear()
    const bar = this.fxStatic.clear()
    const below = this.fxBelow.clear()
    const t = this.theme
    const failed = n?.health === 'failed'
    this.body.tint = this.invalid ? 0xff7070 : failed ? 0x8d97a6 : 0xffffff
    this.slots.tint = this.body.tint
    this.drawSlots(n, now)
    // hover: accent outline + tinted footprint under the part, and the label lights up (body stays opaque)
    const hot = this.hoverGlow > 0.5
    if (hot !== this.labelHot) { this.labelHot = hot; this.nameText.style.fill = hot ? t.accent : t.dim }
    if (this.hoverGlow > 0.02) {
      const { col: hc, row: hr } = this.comp.position
      const [a, b, c, d] = footprint(hc - 0.05, hr - 0.05, 2.1, 2.1)
      below.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill({ color: t.accent, alpha: this.hoverGlow * 0.14 }).stroke({ width: 1.5, color: t.accent, alpha: this.hoverGlow * 0.85 })
    }
    if (!n || this.comp.kind === 'client' && n.offered <= 0) {
      this.stat.text = this.comp.kind === 'client' ? '' : n ? 'IDLE' : ''
      if (!n) return
    }
    const { col, row } = this.comp.position
    const color = n.health === 'failed' ? t.failed : n.health === 'strained' ? t.strained : t.healthy

    if (this.bottleneck) this.tag.alpha = this.reduced ? 1 : 0.8 + 0.2 * Math.sin(now / 280)

    // ground ring: steady for healthy, slow pulse for strained, solid + fill for failed
    if (this.comp.kind !== 'client') {
      const pulse = n.health === 'strained' && !this.reduced ? 0.45 + 0.35 * Math.sin(now / 350) : n.health === 'failed' ? 0.9 : 0.35
      const [a, b, c, d] = footprint(col + 0.1, row + 0.1, 1.8, 1.8)
      below.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill({ color, alpha: n.health === 'failed' ? 0.14 : 0.05 }).stroke({ width: 1.5, color, alpha: pulse })
    }

    // load bar under the label
    const cx = gridToScreen(col + 1, row + 1).x
    const y = gridToScreen(col + 2, row + 2).y + 33
    const frac = Math.min(1, n.util)
    if (this.comp.kind !== 'client') {
      bar.rect(cx - 28, y, 56, 3).fill({ color: t.line, alpha: 0.15 })
      bar.rect(cx - 28, y, 56 * frac, 3).fill({ color })
    }
    const text = this.statText(n)
    if (this.stat.text !== text) this.stat.text = text
    this.stat.style.fill = n.health === 'healthy' ? t.dim : color

    // per-kind gauges
    const cfg = this.comp.config
    switch (this.comp.kind) {
      case 'database': {
        const l = gridToScreen(col + 1, row + 1)
        const frac = n.poolSize > 0 ? Math.min(1, n.poolUsed / n.poolSize) : 0
        const a0 = Math.PI * 0.9
        const gc = n.poolSize > 0 && frac > 0.9 ? t.failed : frac > 0.6 ? t.strained : t.healthy
        fx.moveTo(l.x + Math.cos(a0) * 8, l.y - 12 + Math.sin(a0) * 8).arc(l.x, l.y - 12, 8, a0, a0 + Math.PI * 1.2 * Math.max(0.02, frac)).stroke({ width: 2.5, color: gc })
        break
      }
      case 'appServers': {
        if (this.isAuto) break
        const x = col + 0.25, yy = row + 0.25
        const led = gridToScreen(x + 1.2, yy + 1.5)
        const levels = levelOf(this.comp)
        const lit = Math.ceil(Math.min(1, n.util) * levels)
        for (let i = 0; i < levels; i++) fx.circle(led.x, led.y - i * 15 - 6, 2).fill({ color: i < lit ? color : t.line, alpha: i < lit ? 1 : 0.25 })
        break
      }
      case 'queue': {
        const base = gridToScreen(col + 1.85, row + 1.0)
        const max = cfg.maxDepth ?? 2000
        const h = Math.min(1, n.queueDepth / max) * 38
        bar.rect(base.x - 3, base.y - 38, 6, 38).stroke({ width: 1, color: t.line, alpha: 0.4 })
        if (h > 0.5) bar.rect(base.x - 3, base.y - h, 6, h).fill({ color: h / 38 > 0.8 ? t.failed : t.strained })
        break
      }
      default: break
    }

    // a failed component gets a red "X" badge above it, so failure reads at a glance
    if (failed) {
      const c = gridToScreen(col + 1, row + 1)
      const bb = this.body.getLocalBounds()
      const top = bb.minY + bb.height * 0.45
      fx.circle(c.x, top, 9).fill({ color: t.failed }).stroke({ width: 1.5, color: '#ffffff' })
      fx.moveTo(c.x - 3.5, top - 3.5).lineTo(c.x + 3.5, top + 3.5).moveTo(c.x + 3.5, top - 3.5).lineTo(c.x - 3.5, top + 3.5).stroke({ width: 1.8, color: '#ffffff', cap: 'round' })
    }
  }

  /** Autoscaling group: solid slots are running, pulsing amber ones are starting up, outlines are unused headroom. */
  private drawSlots(n: NodeResult | undefined, now: number) {
    const g = this.slots.clear()
    if (!this.isAuto) return
    const { col, row } = this.comp.position
    const max = n?.scaling?.max ?? configValue('appServers', this.comp.config, 'maxInstances') ?? 8
    const active = n?.scaling?.active ?? this.comp.config.instances ?? 1
    const pending = n?.scaling?.pending ?? 0
    const cap = Math.min(12, max)
    const cols = Math.min(4, cap), rows = Math.ceil(cap / cols)
    const step = 0.45, size = 0.38
    const slotH = 12 + 3 * levelOf(this.comp) // bigger instances, taller slots
    const ox = col + 0.1 + (1.8 - (cols * step - 0.07)) / 2
    const oy = row + 0.1 + (1.8 - (rows * step - 0.07)) / 2
    const c = this.theme.line
    const pulse = this.reduced ? 1 : 0.55 + 0.45 * Math.sin(now / 260)
    // back to front, so nearer slots are drawn over farther ones
    for (let sum = 0; sum <= cols + rows - 2; sum++) {
      for (let j = 0; j < rows; j++) {
        const i = sum - j
        if (i < 0 || i >= cols) continue
        const idx = j * cols + i
        if (idx >= cap) continue
        const x = ox + i * step, y = oy + j * step
        if (idx < active) isoBox(g, x, y, size, size, slotH, c, 3, 0.2)
        else if (idx < active + pending) {
          isoBox(g, x, y, size, size, 7 + (slotH - 7) * pulse, this.theme.strained, 3, 0.3)
        } else isoWire(g, x, y, size, size, slotH, c, 3, 0.42)
      }
    }
  }

  private statText(n: NodeResult): string {
    if (n.down) return 'DOWN'
    switch (this.comp.kind) {
      case 'client': return `${Math.round(n.offered)} RPS · ${REGIONS[regionOf(this.comp)].short}`
      case 'cache':
      case 'cdn': return n.offered > 0 ? `HIT ${Math.round(n.hit * 100)}%` : 'IDLE'
      case 'queue': return `DEPTH ${Math.round(n.queueDepth)}`
      default: {
        if (n.down) return 'DOWN'
        const pct = `${Math.round(n.util * 100)}%`
        if (n.scaling) return `${n.scaling.active}${n.scaling.pending ? `+${n.scaling.pending}` : ''}/${n.scaling.max} · ${pct}`
        if (n.injected === 'slow') return `SLOW ${pct}`
        if (n.injected === 'lostInstance') return `-1 NODE ${pct}`
        const blocked = n.blocked >= 0.5 ? ` · ${Math.round(n.blocked)} BLOCKED` : geoModeOf(this.comp) !== GEO_OFF ? ' · GEO' : ''
        const replicasTxt = this.comp.kind === 'database' && (configValue('database', this.comp.config, 'replicas') ?? 0) > 0 ? ` · +${Math.round(configValue('database', this.comp.config, 'replicas') ?? 0)}R` : ''
        const coldTxt = this.comp.kind === 'serverless' && (n.cold ?? 0) > 0.01 ? ` · COLD ${Math.round((n.cold ?? 0) * 100)}%` : ''
        const limiting = this.comp.kind === 'gateway' && n.dropped >= 1 ? ' · LIMITING' : ''
        return (n.offered > 0 ? pct : 'IDLE') + replicasTxt + limiting + coldTxt + blocked
      }
    }
  }
}
