import { Graphics } from 'pixi.js'
import { gridToScreen, footprint, type Pt } from '../lib/iso'
import type { Theme } from '../lib/theme'
import type { Architecture } from '../store/types'
import type { TraceUI } from '../sim/traceStore'
import { useTrace } from '../sim/traceStore'
import type { Path } from './Particles'

const DWELL_MS = 650
const SPEED_PX_PER_MS = 0.26
const LIFT = 10 // the dot rides a little above the ground path
const hex = (s: string) => parseInt(s.replace('#', ''), 16)

interface Leg { from: Pt; path: Path | null; dwell0: number; dwell1: number; travel1: number }

function at(path: Path, d: number): Pt {
  const dd = Math.min(Math.max(d, 0), path.len)
  for (let i = 1; i < path.pts.length; i++) {
    if (dd <= path.cum[i] && path.cum[i] > path.cum[i - 1]) {
      const k = (dd - path.cum[i - 1]) / (path.cum[i] - path.cum[i - 1])
      return { x: path.pts[i - 1].x + (path.pts[i].x - path.pts[i - 1].x) * k, y: path.pts[i - 1].y + (path.pts[i].y - path.pts[i - 1].y) * k }
    }
  }
  return path.pts[path.pts.length - 1]
}

/** Animates one traced request: a bright dot that rides each connection and pauses at every hop. */
export class TracePlayer {
  readonly g = new Graphics()
  private id = -1
  private legs: Leg[] = []
  private cols: { accent: number; ok: number; bad: number }

  constructor(theme: Theme) {
    this.cols = { accent: hex(theme.accent), ok: hex(theme.healthy), bad: hex(theme.failed) }
  }

  private build(ui: TraceUI, paths: Map<string, Path>, arch: Architecture) {
    const trace = ui.trace!
    const pos = (id: string): Pt => {
      const c = arch.components.find((x) => x.id === id)
      return c ? gridToScreen(c.position.col + 1, c.position.row + 1) : { x: 0, y: 0 }
    }
    this.legs = []
    let t = 0
    trace.hops.forEach((h, i) => {
      const dwell0 = t
      const dwell1 = t + DWELL_MS
      const edge = trace.edges[i]
      const path = edge ? paths.get(edge) ?? null : null
      const travel = path ? Math.max(280, path.len / SPEED_PX_PER_MS) : 0
      this.legs.push({ from: pos(h.nodeId), path, dwell0, dwell1, travel1: dwell1 + travel })
      t = dwell1 + travel
    })
    this.id = trace.id
    useTrace.setState({ schedule: this.legs.map((l) => ({ start: l.dwell0, end: l.dwell1 })), total: t })
  }

  update(ui: TraceUI, paths: Map<string, Path>, arch: Architecture) {
    const g = this.g.clear()
    const trace = ui.trace
    if (!trace) { this.id = -1; return }
    if (this.id !== trace.id) this.build(ui, paths, arch)
    const e = performance.now() - ui.startedAt
    const last = this.legs.length - 1

    // rings under every hop reached so far
    trace.hops.forEach((h, i) => {
      const leg = this.legs[i]
      if (!leg || e < leg.dwell0) return
      const comp = arch.components.find((c) => c.id === h.nodeId)
      if (!comp) return
      const col = h.outcome === 'dropped' ? this.cols.bad : h.outcome === 'hit' ? this.cols.ok : this.cols.accent
      const [t, r, b, l] = footprint(comp.position.col - 0.05, comp.position.row - 0.05, 2.1, 2.1)
      const current = e >= leg.dwell0 && e <= leg.dwell1
      g.poly([t.x, t.y, r.x, r.y, b.x, b.y, l.x, l.y]).fill({ color: col, alpha: current ? 0.16 : 0.07 }).stroke({ width: current ? 2 : 1.2, color: col, alpha: current ? 0.95 : 0.55 })
    })

    // where is the dot?
    let p: Pt = { x: this.legs[0].from.x, y: this.legs[0].from.y }
    let heading: Path | null = null
    let progress = 0
    for (let i = 0; i <= last; i++) {
      const leg = this.legs[i]
      if (e <= leg.dwell1 || i === last) { p = leg.from; heading = null; break }
      if (e <= leg.travel1 && leg.path) {
        progress = (e - leg.dwell1) / Math.max(1, leg.travel1 - leg.dwell1)
        p = at(leg.path, progress * leg.path.len)
        heading = leg.path
        break
      }
    }

    const finished = e > this.legs[last].dwell1
    const y = (v: Pt) => v.y - LIFT
    if (heading) {
      // short fading trail behind the dot
      for (let k = 1; k <= 7; k++) {
        const q = at(heading, Math.max(0, progress * heading.len - k * 9))
        g.circle(q.x, y(q), Math.max(1.5, 5 - k * 0.5)).fill({ color: this.cols.accent, alpha: 0.4 - k * 0.05 })
      }
    }
    const lastHop = trace.hops[last]
    const endCol = lastHop.outcome === 'dropped' ? this.cols.bad : this.cols.ok
    if (finished) {
      // end marker stays until the card is closed: a tick for success, a cross for a failed request
      g.circle(p.x, y(p), 9).fill({ color: endCol })
      if (lastHop.outcome === 'dropped') g.moveTo(p.x - 3.5, y(p) - 3.5).lineTo(p.x + 3.5, y(p) + 3.5).moveTo(p.x + 3.5, y(p) - 3.5).lineTo(p.x - 3.5, y(p) + 3.5).stroke({ width: 2, color: 0xffffff })
      else g.moveTo(p.x - 4, y(p)).lineTo(p.x - 1, y(p) + 3).lineTo(p.x + 4.5, y(p) - 3.5).stroke({ width: 2, color: 0xffffff })
    } else {
      const pulse = 0.5 + 0.5 * Math.sin(e / 140)
      g.circle(p.x, y(p), 11 + 2 * pulse).fill({ color: this.cols.accent, alpha: 0.18 })
      g.circle(p.x, y(p), 5.5).fill({ color: this.cols.accent }).stroke({ width: 1.8, color: 0xffffff })
    }
  }
}
