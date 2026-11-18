/**
 * Network time between regions. Each component may sit in a region; a request that crosses from one region to
 * another pays a round trip (out and back) plus the time to move its data, on top of the time every component
 * spends processing it.
 *
 * A component with no region of its own is taken to be wherever its caller is, so a design that never sets one
 * (every design saved before this existed) has no network time at all, exactly as before.
 *
 * The numbers are assumed and rounded: typical long-haul round trips, not measurements of any cloud.
 */
import type { ArchComponent, Architecture } from '../store/types'
import { regionOf, REGIONS } from './geo'

/** `region` value meaning "wherever my caller is". */
export const INHERIT_REGION = -1

/** Round-trip time in ms between two regions, in the order of REGIONS (us-east, us-west, eu, apac, latam, mea). */
const RTT_MS: number[][] = [
  [0, 65, 85, 200, 120, 150],
  [65, 0, 140, 125, 160, 230],
  [85, 140, 0, 230, 190, 110],
  [200, 125, 230, 0, 320, 130],
  [120, 160, 190, 320, 0, 250],
  [150, 230, 110, 130, 250, 0],
]

/** Throughput assumed for moving a response between regions, in megabits per second (= kilobits per ms). */
export const CROSS_REGION_MBPS = 200
/** Network time varies a little less than processing does: the p99 of a hop's travel time over its median. */
export const NET_TAIL = 1.2

/** Round-trip time between two regions. Within one region it is already part of each component's own latency. */
export const rttBetween = (a: number, b: number): number => (a === b ? 0 : RTT_MS[a]?.[b] ?? 0)

/** Time to move `kb` kilobytes of response across regions. */
export const transferMs = (kb: number): number => (kb * 8) / CROSS_REGION_MBPS

/** The region a component was explicitly placed in, or null when it follows its caller. A client always has one. */
export function explicitRegion(c: Pick<ArchComponent, 'kind' | 'config'>): number | null {
  if (c.kind === 'client') return regionOf(c)
  const v = c.config.region
  if (v === undefined || !(v >= 0)) return null
  const r = Math.round(v)
  return r < REGIONS.length ? r : null
}

/**
 * The region each component effectively sits in: its own if it has one, otherwise its caller's. A component
 * that nothing reaches and has no region of its own is left out, and hops involving it cost nothing.
 */
export function effectiveRegions(arch: Architecture): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of arch.components) { const r = explicitRegion(c); if (r !== null) out.set(c.id, r) }
  for (let changed = true, guard = 0; changed && guard < arch.components.length + 1; guard++) {
    changed = false
    for (const e of arch.connections) {
      if (out.has(e.to) || !out.has(e.from)) continue
      out.set(e.to, out.get(e.from)!)
      changed = true
    }
  }
  return out
}

/** What one hop costs in network time, in ms: the round trip, and moving `kb` of response over it. */
export function hopNetwork(regions: Map<string, number>, from: string, to: string, kb: number): { rttMs: number; transferMs: number } {
  const a = regions.get(from), b = regions.get(to)
  if (a === undefined || b === undefined || a === b) return { rttMs: 0, transferMs: 0 }
  return { rttMs: rttBetween(a, b), transferMs: transferMs(kb) }
}
