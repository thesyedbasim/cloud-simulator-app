/** Isometric 2:1 projection. One grid cell is TILE_W wide and TILE_H tall on screen. */
export const TILE_W = 64
export const TILE_H = 32

export interface Pt { x: number; y: number }

export function gridToScreen(col: number, row: number): Pt {
  return { x: ((col - row) * TILE_W) / 2, y: ((col + row) * TILE_H) / 2 }
}

export function screenToGrid(x: number, y: number): { col: number; row: number } {
  const a = x / (TILE_W / 2)
  const b = y / (TILE_H / 2)
  return { col: Math.floor((a + b) / 2), row: Math.floor((b - a) / 2) }
}

/** Corners of a cell footprint: top, right, bottom, left. */
export function footprint(col: number, row: number, w = 1, d = 1): Pt[] {
  return [gridToScreen(col, row), gridToScreen(col + w, row), gridToScreen(col + w, row + d), gridToScreen(col, row + d)]
}

/** Fractional grid coordinates (not floored). Also valid for screen-space deltas. */
export function screenToGridF(x: number, y: number) {
  const a = x / (TILE_W / 2)
  const b = y / (TILE_H / 2)
  return { col: (a + b) / 2, row: (b - a) / 2 }
}

export function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
