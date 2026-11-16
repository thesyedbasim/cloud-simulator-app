import type { Architecture } from './types'

export const BOUND = 22
export const FOOT = 2 // every component occupies a 2×2 footprint

export function overlaps(arch: Architecture, col: number, row: number, ignoreId?: string) {
  return arch.components.some((o) => o.id !== ignoreId && Math.abs(o.position.col - col) < FOOT && Math.abs(o.position.row - row) < FOOT)
}
export const inBounds = (col: number, row: number) => Math.abs(col) <= BOUND && Math.abs(row) <= BOUND
export const canPlace = (arch: Architecture, col: number, row: number, ignoreId?: string) => inBounds(col, row) && !overlaps(arch, col, row, ignoreId)

/** Nearest free 2×2 slot to (col,row), searching outward in rings. */
export function findFreeCell(arch: Architecture, col: number, row: number, gap = 1) {
  for (let r = 0; r < 14; r++)
    for (let dc = -r; dc <= r; dc++)
      for (let dr = -r; dr <= r; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue
        const c = col + dc, rw = row + dr
        const clear = !arch.components.some((o) => Math.abs(o.position.col - c) < FOOT + gap && Math.abs(o.position.row - rw) < FOOT + gap)
        if (clear && canPlace(arch, c, rw)) return { col: col + dc, row: row + dr }
      }
  return null
}
