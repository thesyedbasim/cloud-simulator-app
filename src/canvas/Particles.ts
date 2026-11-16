import { Graphics } from 'pixi.js'
import type { Pt } from '../lib/iso'
import type { Theme } from '../lib/theme'
import type { StepResult } from '../sim/engine'

export interface Path { pts: Pt[]; cum: number[]; len: number }

export function makePath(pts: Pt[]): Path {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return { pts, cum, len: cum[cum.length - 1] }
}

function pointAt(p: Path, d: number): Pt {
  const dd = Math.min(Math.max(d, 0), p.len)
  for (let i = 1; i < p.pts.length; i++) {
    if (dd <= p.cum[i] && p.cum[i] > p.cum[i - 1]) {
      const k = (dd - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1])
      return { x: p.pts[i - 1].x + (p.pts[i].x - p.pts[i - 1].x) * k, y: p.pts[i - 1].y + (p.pts[i].y - p.pts[i - 1].y) * k }
    }
  }
  return p.pts[p.pts.length - 1]
}

interface P { edge: string; d: number; bad: boolean; color: number; wait: number; x: number; y: number }

const hex = (s: string) => parseInt(s.replace('#', ''), 16)

/**
 * Visual-only traffic. 600 rps is not 600 particles: spawn rate is sampled from edge throughput
 * and capped, so animation cost never affects the simulation.
 */
export class Particles {
  readonly g = new Graphics()
  private ps: P[] = []
  private spawn = new Map<string, number>()
  private flow = 1
  private cols: { ok: number; strained: number; bad: number }
  private cap: number

  constructor(theme: Theme) {
    this.cols = { ok: hex(theme.accent), strained: hex(theme.strained), bad: hex(theme.failed) }
    this.cap = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 80 : 420
  }

  /** The connection carrying the dot nearest to `world`, if one is within `tol` pixels. */
  hit(world: Pt, tol: number): string | null {
    let best: string | null = null
    let bestD = tol
    for (const p of this.ps) {
      if (p.bad) continue
      const d = Math.hypot(p.x - world.x, p.y - world.y)
      if (d < bestD) { bestD = d; best = p.edge }
    }
    return best
  }

  update(dt: number, paths: Map<string, Path>, res: StepResult | null, running: boolean, speed: number) {
    // ease to a stop on pause instead of freezing
    this.flow += ((running ? 1 : 0) - this.flow) * Math.min(1, dt * 4)
    const g = this.g.clear()
    const vmul = Math.min(2, Math.max(0.5, speed)) * this.flow
    const live = new Set(paths.keys())

    if (res && this.flow > 0.02) {
      for (const [id, e] of Object.entries(res.edges)) {
        const path = paths.get(id)
        if (!path || path.len < 1 || e.rps < 1) continue
        const rate = Math.min(16, 2 + e.rps / 70) * this.flow
        let a = (this.spawn.get(id) ?? 0) + rate * dt
        while (a >= 1 && this.ps.length < this.cap) {
          a -= 1
          const bad = Math.random() < e.dropFrac
          this.ps.push({ edge: id, d: 0, bad, color: bad ? this.cols.bad : this.cols.ok, wait: 0, x: 0, y: 0 })
        }
        this.spawn.set(id, a % 1)
      }
    }

    const next: P[] = []
    for (const p of this.ps) {
      const path = paths.get(p.edge)
      if (!path || !live.has(p.edge)) continue
      const speedPx = 150 * vmul
      const stop = p.bad ? path.len * 0.86 : path.len
      if (p.d < stop) p.d += speedPx * dt
      else if (p.bad) p.wait += dt
      if (p.bad ? p.wait > 0.7 : p.d >= path.len) continue
      const pt = pointAt(path, p.d)
      p.x = pt.x
      p.y = pt.y
      const fade = p.bad ? 1 - p.wait / 0.7 : p.d > path.len - 20 ? Math.max(0, (path.len - p.d) / 20) : 1
      g.circle(pt.x, pt.y, p.bad ? 2.6 : 2).fill({ color: p.color, alpha: 0.9 * fade })
      next.push(p)
    }
    this.ps = next
  }
}
