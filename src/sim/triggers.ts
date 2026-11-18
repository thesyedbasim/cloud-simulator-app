/**
 * Triggers on a serverless function. A schedule fires `batch` invocations every `everySec` seconds (modelled as the average rate).
 * An event trigger runs the function `ratio` times for every write its source component handles. Because the function can write
 * to something that triggers it, the engine reads the write rate from the previous step, and loops show up as a rate that keeps climbing.
 */
import type { ArchComponent, Architecture } from '../store/types'

export interface Trigger {
  id: string
  kind: 'schedule' | 'event'
  /** schedule: seconds between runs */
  everySec?: number
  /** schedule: invocations per run */
  batch?: number
  /** event: the component whose writes trigger the function */
  source?: string
  /** event: invocations per write */
  ratio?: number
  /** share of the triggered runs' work that reads (the rest writes) */
  readPct?: number
  /** the application (on this function) the triggered runs execute; unset = the default run */
  app?: string
}

export const MAX_TRIGGER_RPS = 1e6
/** The recursion guard stops a chain after this many runs, as real platforms do. */
export const RECURSION_LIMIT = 16

export const triggerKey = (fnId: string, t: Trigger) => `trigger:${fnId}:${t.id}`
export const triggersOf = (c: ArchComponent): Trigger[] => (c.kind === 'serverless' ? c.triggers ?? [] : [])

/** Can the function's own writes reach the component that triggers it? Follows connections downstream. */
export function isLoop(arch: Architecture, fnId: string, source: string | undefined): boolean {
  if (!source) return false
  const seen = new Set<string>([fnId])
  const queue = [fnId]
  while (queue.length) {
    const id = queue.shift()!
    for (const e of arch.connections) {
      if (e.from !== id) continue
      if (e.to === source) return true
      if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to) }
    }
  }
  return false
}

export interface TriggerFlow { key: string; rps: number; readPct: number; loop: boolean; app?: string }

/** Invocations per second each trigger produces now, from last step's write rates. */
export function triggerFlows(arch: Architecture, c: ArchComponent, writes: Record<string, number>, edgeRps: Record<string, number>, guard: boolean): TriggerFlow[] {
  return triggersOf(c).flatMap((t) => {
    // reads vs writes come from the application the trigger runs; with none, triggered work writes
    const readPct = t.app ? (c.apps?.find((a) => a.id === t.app)?.readPct ?? 0.9) : 0
    if (t.kind === 'schedule') return [{ key: triggerKey(c.id, t), rps: Math.min(MAX_TRIGGER_RPS, (t.batch ?? 1) / Math.max(0.1, t.everySec ?? 60)), readPct, loop: false, app: t.app }]
    const src = t.source
    if (!src || !arch.components.some((x) => x.id === src)) return []
    const loop = isLoop(arch, c.id, src)
    let w = writes[src] ?? 0
    // The recursion guard ignores writes that came from this function itself (the direct kind of loop).
    if (guard) { const own = arch.connections.filter((e) => e.from === c.id && e.to === src).reduce((a, e) => a + (edgeRps[e.id] ?? 0) * (1 - readPct), 0); w = Math.max(0, w - own) }
    return [{ key: triggerKey(c.id, t), rps: Math.min(MAX_TRIGGER_RPS, w * Math.max(0, t.ratio ?? 1)), readPct, loop, app: t.app }]
  })
}
