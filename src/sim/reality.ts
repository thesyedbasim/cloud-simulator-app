/**
 * Projected vs actual: set numbers measured on the real system beside what the model says, and say plainly where they
 * disagree and what that probably means. The model is small on purpose, so a gap is information, not a bug.
 */
import type { Actual, Architecture } from '../store/types'
import { equilibrium, findCapacity } from './finder'

export type Verdict = 'close' | 'optimistic' | 'pessimistic'
export interface Gap {
  metric: 'p99' | 'errors' | 'capacity'
  label: string
  projected: number
  actual: number
  unit: string
  /** How the model compares with reality. */
  verdict: Verdict
  /** actual ÷ projected (for errors, the difference in percentage points instead). */
  ratio: number
  note: string
}

/** Within this factor (or, for errors, this many percentage points) counts as close. */
export const CLOSE_FACTOR = 1.25
export const CLOSE_POINTS = 0.5

export interface Projection { p99Ms: number; errorPct: number; maxRps: number | null }

/** What the model projects for the design at today's steady load. */
export function project(arch: Architecture): Projection {
  const now = equilibrium(arch, 1)
  const cap = findCapacity(arch)
  return { p99Ms: now.totals.p99, errorPct: now.totals.errorRate * 100, maxRps: cap?.maxRps ?? null }
}

export function compareToReality(arch: Architecture, actual: Actual, projection: Projection = project(arch)): Gap[] {
  const gaps: Gap[] = []
  if (actual.p99Ms !== undefined) {
    const ratio = actual.p99Ms / Math.max(1, projection.p99Ms)
    const verdict: Verdict = ratio > CLOSE_FACTOR ? 'optimistic' : ratio < 1 / CLOSE_FACTOR ? 'pessimistic' : 'close'
    gaps.push({
      metric: 'p99', label: 'Latency (p99)', projected: projection.p99Ms, actual: actual.p99Ms, unit: 'ms', verdict, ratio,
      note: verdict === 'close' ? 'The model and the measurement agree on latency.'
        : verdict === 'optimistic' ? `The real p99 is ${ratio.toFixed(1)}× the model's. Common causes: network hops, serialisation, garbage collection pauses, slow queries and cold caches, none of which the model has.`
        : `The real p99 is only ${(1 / ratio).toFixed(1)}× lower than the model's: the model's base latencies are probably too high for this system.`,
    })
  }
  if (actual.errorPct !== undefined) {
    const diff = actual.errorPct - projection.errorPct
    const verdict: Verdict = diff > CLOSE_POINTS ? 'optimistic' : diff < -CLOSE_POINTS ? 'pessimistic' : 'close'
    gaps.push({
      metric: 'errors', label: 'Error rate', projected: projection.errorPct, actual: actual.errorPct, unit: '%', verdict, ratio: diff,
      note: verdict === 'close' ? 'The model and the measurement agree on errors.'
        : verdict === 'optimistic' ? `Real errors are ${diff.toFixed(1)} points higher than the model's. The model only fails requests for lack of capacity and timeouts: bugs, bad inputs, dependencies it does not know about and deploys all add errors it cannot see.`
        : `The model projects ${(-diff).toFixed(1)} points more errors than were measured. Real systems may shed or queue load in ways the model does not.`,
    })
  }
  if (actual.maxRps !== undefined && projection.maxRps !== null) {
    const ratio = actual.maxRps / Math.max(1, projection.maxRps)
    const verdict: Verdict = ratio < 1 / CLOSE_FACTOR ? 'optimistic' : ratio > CLOSE_FACTOR ? 'pessimistic' : 'close'
    gaps.push({
      metric: 'capacity', label: 'Capacity (requests per second)', projected: projection.maxRps, actual: actual.maxRps, unit: 'rps', verdict, ratio,
      note: verdict === 'close' ? 'The model and the measurement agree on how much load it takes.'
        : verdict === 'optimistic' ? `The system breaks at ${Math.round((1 - ratio) * 100)}% less load than the model says. Look for a limit the model lacks: a lock, a single hot row, a downstream quota, a connection limit.`
        : `The system takes ${ratio.toFixed(1)}× the load the model says. The per-instance capacity figures (rps per vCPU and per GB) may be conservative for your workload.`,
    })
  }
  return gaps
}
