import { Graphics } from 'pixi.js'
import { gridToScreen, footprint, type Pt } from '../lib/iso'

const H = 1 // pixels per unit of height

let paper = '#f2f6fb'
export const setPaper = (c: string) => { paper = c }

const toRgb = (hex: string) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
/** Opaque colour: `amount` of `ink` blended over the paper. Solid faces hide whatever is behind them. */
export function solid(ink: string, amount: number): number {
  const [r1, g1, b1] = toRgb(paper), [r2, g2, b2] = toRgb(ink)
  const m = (a: number, b: number) => Math.round(a + (b - a) * amount)
  return (m(r1, r2) << 16) | (m(g1, g2) << 8) | m(b1, b2)
}

/**
 * Draw an isometric box (footprint w×d cells, height h px) anchored at cell (col,row).
 * `tint` is how strongly the ink colour shows in the faces. Faces are fully opaque.
 */
export function isoBox(g: Graphics, col: number, row: number, w: number, d: number, h: number, line: string, lift = 0, tint = 0.18) {
  const [t, r, b, l] = footprint(col, row, w, d).map((p) => ({ x: p.x, y: p.y - lift * H }))
  const up = (p: Pt) => ({ x: p.x, y: p.y - h * H })
  const top = [t, r, b, l].map(up)
  g.poly([l.x, l.y, b.x, b.y, up(b).x, up(b).y, up(l).x, up(l).y]).fill({ color: solid(line, tint * 0.9) }).stroke({ width: 1, color: line, alpha: 0.85 })
  g.poly([b.x, b.y, r.x, r.y, up(r).x, up(r).y, up(b).x, up(b).y]).fill({ color: solid(line, tint * 1.5) }).stroke({ width: 1, color: line, alpha: 0.85 })
  g.poly(top.flatMap((p) => [p.x, p.y])).fill({ color: solid(line, tint * 0.35) }).stroke({ width: 1, color: line, alpha: 1 })
  return top
}

/** Isometric ellipse (circle on the ground plane) centred on a cell-space point. */
export function isoEllipse(g: Graphics, cx: number, cy: number, radius: number, lift: number) {
  const c = gridToScreen(cx, cy)
  g.ellipse(c.x, c.y - lift, radius * 32, radius * 16)
}

export function isoPath(g: Graphics, pts: Pt[]) {
  g.moveTo(pts[0].x, pts[0].y)
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y)
}

/** L-shaped route between two components (top-left cell positions): along columns, then rows. */
export function connectionPts(a: { col: number; row: number }, b: { col: number; row: number }): Pt[] {
  const ca = { col: a.col + 1, row: a.row + 1 }
  const cb = { col: b.col + 1, row: b.row + 1 }
  return [gridToScreen(ca.col, ca.row), gridToScreen(cb.col, ca.row), gridToScreen(cb.col, cb.row)]
}

/** Outline-only box: an empty "ghost" slot. Draws strokes, never fills, so it hides nothing behind it. */
export function isoWire(g: Graphics, col: number, row: number, w: number, d: number, h: number, line: string, lift = 0, alpha = 0.3) {
  const [t, r, b, l] = footprint(col, row, w, d).map((p) => ({ x: p.x, y: p.y - lift * H }))
  const up = (p: Pt) => ({ x: p.x, y: p.y - h * H })
  g.poly([up(t).x, up(t).y, up(r).x, up(r).y, up(b).x, up(b).y, up(l).x, up(l).y]).stroke({ width: 1, color: line, alpha })
  g.moveTo(l.x, l.y).lineTo(up(l).x, up(l).y).moveTo(b.x, b.y).lineTo(up(b).x, up(b).y).moveTo(r.x, r.y).lineTo(up(r).x, up(r).y).stroke({ width: 1, color: line, alpha: alpha * 0.7 })
  g.poly([l.x, l.y, b.x, b.y, r.x, r.y]).stroke({ width: 1, color: line, alpha: alpha * 0.5 })
}

/** A pipe: a dark outline with a lighter body, polyline in screen space, ending in a round cap. */
export function isoTube(g: Graphics, pts: Pt[], ink: string, bodyTint = 0.3, width = 6) {
  const path = () => { g.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) g.lineTo(q.x, q.y) }
  path()
  g.stroke({ width: width + 2.2, color: ink, alpha: 0.9, cap: 'round', join: 'round' })
  path()
  g.stroke({ width, color: solid(ink, bodyTint), cap: 'round', join: 'round' })
}

/** Opaque upright cylinder centred on a ground point (screen px). The top cap is the last thing drawn. */
export function isoCylinder(g: Graphics, cx: number, cy: number, rx: number, ry: number, ht: number, ink: string) {
  const side = solid(ink, 0.16), cap = solid(ink, 0.06)
  const stroke = { width: 1, color: ink, alpha: 0.9 }
  g.ellipse(cx, cy, rx, ry).fill({ color: side }).stroke(stroke)
  g.rect(cx - rx, cy - ht, rx * 2, ht).fill({ color: side })
  g.moveTo(cx - rx, cy).lineTo(cx - rx, cy - ht).moveTo(cx + rx, cy).lineTo(cx + rx, cy - ht).stroke(stroke)
  g.moveTo(cx - rx, cy)
  for (let k = 1; k <= 24; k++) { const a = Math.PI * (k / 24); g.lineTo(cx - Math.cos(a) * rx, cy + Math.sin(a) * ry) }
  g.stroke({ width: 1, color: ink, alpha: 0.9 })
  g.ellipse(cx, cy - ht, rx, ry).fill({ color: cap }).stroke({ width: 1, color: ink })
}
