/**
 * Runs a scenario to completion with no UI, instantly. Same engine and same rules as the live simulation,
 * so a result here is exactly what you would see by watching it.
 */
import type { Architecture } from '../store/types'
import { freshState, step, type Injected } from './engine'
import { planScenario, SUITE_IDS, type ScenarioId } from './scenarios'
import { accumulate, sloOf, sloStatus, zeroCounters, type SloStatus } from './slo'

/** A scenario "survives" if errors never exceed this share of requests. */
export const PASS_ERR = 0.02
export const RUN_SECONDS = 60

export interface RunSummary {
  id: ScenarioId
  label: string
  /** Per-second samples. */
  t: number[]
  err: number[]
  p99: number[]
  rps: number[]
  peakErr: number
  peakP99: number
  /** Most components failing at the same moment. Lets a fix that rescues one link of a chain count as progress. */
  peakFailedNodes: number
  minThroughput: number
  cost: number
  /** Seconds during which errors were above the pass line. Autoscaling shortens this even when it cannot lower the peak. */
  errSeconds: number
  /** Sim second at which errors first exceeded the pass line, or null. */
  firstFailure: number | null
  /** Sim second the fault lands (for chart markers). */
  faultAt: number
  passes: boolean
  /** How the run fares against the design's service-level targets (availability over the run, latency in target). */
  slo: SloStatus
  /** Set when the architecture has nothing this scenario can act on. */
  skipped?: string
}

export function runScenario(arch: Architecture, id: ScenarioId, seconds = RUN_SECONDS): RunSummary {
  const plan = planScenario(arch, id)
  const base: RunSummary = { id, label: plan.label, t: [], err: [], p99: [], rps: [], peakErr: 0, peakP99: 0, peakFailedNodes: 0, errSeconds: 0, minThroughput: Infinity, cost: 0, firstFailure: null, faultAt: plan.at, passes: true, slo: sloStatus(zeroCounters(), sloOf(arch)) }
  if (plan.empty) return { ...base, minThroughput: 0, skipped: plan.empty }

  let state = freshState()
  let injected: Record<string, Injected> = {}
  let fired = false
  let cleared = false
  const slo = sloOf(arch)
  let counters = zeroCounters()
  const steps = seconds * 10
  for (let i = 0; i <= steps; i++) {
    if (!fired && state.t >= plan.at) { injected = plan.injections; fired = true }
    else if (fired && !cleared && plan.until !== undefined && state.t >= plan.until) { injected = {}; cleared = true }
    const out = step(arch, state, i === 0 ? 0 : 0.1, { shape: plan.shape ?? 'steady', injected })
    state = out.state
    const tot = out.result.totals
    base.peakErr = Math.max(base.peakErr, tot.errorRate)
    base.peakP99 = Math.max(base.peakP99, tot.p99)
    base.peakFailedNodes = Math.max(base.peakFailedNodes, Object.values(out.result.nodes).filter((n) => n.health === 'failed').length)
    base.minThroughput = Math.min(base.minThroughput, tot.throughput)
    base.cost = tot.cost
    if (i > 0) counters = accumulate(counters, tot, 0.1, slo)
    if (base.firstFailure === null && tot.errorRate > PASS_ERR) base.firstFailure = Math.round(state.t * 10) / 10
    if (i > 0 && tot.errorRate > PASS_ERR) base.errSeconds += 0.1
    if (i % 10 === 0) {
      base.t.push(i / 10)
      base.err.push(tot.errorRate * 100)
      base.p99.push(tot.p99)
      base.rps.push(tot.throughput)
    }
  }
  base.passes = base.peakErr <= PASS_ERR
  base.slo = sloStatus(counters, slo)
  base.errSeconds = Math.round(base.errSeconds * 10) / 10
  if (!isFinite(base.minThroughput)) base.minThroughput = 0
  return base
}

export interface Suite {
  runs: RunSummary[]
  /** Sum of peak error rates across the scenarios that could run: lower is better. */
  score: number
  failing: ScenarioId[]
  cost: number
}

export function runSuite(arch: Architecture, ids: ScenarioId[] = SUITE_IDS): Suite {
  const runs = ids.map((id) => runScenario(arch, id))
  const live = runs.filter((r) => !r.skipped)
  return {
    runs,
    // errors dominate; each simultaneously failing component adds a little so partial progress is visible
    score: live.reduce((a, r) => a + r.peakErr + 0.03 * r.peakFailedNodes + 0.3 * (r.errSeconds / RUN_SECONDS), 0),
    failing: live.filter((r) => !r.passes).map((r) => r.id),
    cost: runs[0]?.cost ?? 0,
  }
}
