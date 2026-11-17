/**
 * Runs a scenario to completion with no UI, instantly. Same engine and same rules as the live simulation,
 * so a result here is exactly what you would see by watching it.
 */
import type { Architecture, Experiment } from '../store/types'
import { experimentSeconds, faultsAt } from './chaos'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { planScenario, SUITE_IDS, type ScenarioId } from './scenarios'
import { accumulate, sloOf, sloStatus, zeroCounters, type SloStatus } from './slo'

/** A scenario "survives" if errors never exceed this share of requests. */
export const PASS_ERR = 0.02
export const RUN_SECONDS = 60

export interface RunSummary {
  id: ScenarioId | 'experiment'
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
  if (plan.empty) return { ...emptyRun(arch, id, plan.label, plan.at), minThroughput: 0, skipped: plan.empty }
  // the faults land at `at` and, for a brief failure, are lifted again at `until`
  const injectedAt = (t: number): Record<string, Injected> => (t + 1e-9 < plan.at || (plan.until !== undefined && t + 1e-9 >= plan.until) ? {} : plan.injections) // the epsilon keeps 0.1 s steps from landing a step late through rounding
  return simulate(arch, id, plan.label, plan.shape ?? 'steady', plan.at, injectedAt, seconds)
}

/** Runs a saved chaos experiment: the same engine, with its faults applied on its timeline. */
export function runExperiment(arch: Architecture, exp: Experiment, seconds = experimentSeconds(exp)): RunSummary {
  const first = exp.events.length ? Math.min(...exp.events.map((e) => e.at)) : 0
  return simulate(arch, 'experiment', exp.name, exp.shape ?? 'steady', first, (t) => faultsAt(exp.events, t), seconds)
}

const emptyRun = (arch: Architecture, id: RunSummary['id'], label: string, faultAt: number): RunSummary => ({ id, label, t: [], err: [], p99: [], rps: [], peakErr: 0, peakP99: 0, peakFailedNodes: 0, errSeconds: 0, minThroughput: Infinity, cost: 0, firstFailure: null, faultAt, passes: true, slo: sloStatus(zeroCounters(), sloOf(arch)) })

function simulate(arch: Architecture, id: RunSummary['id'], label: string, shape: TrafficShape, faultAt: number, injectedAt: (t: number) => Record<string, Injected>, seconds: number): RunSummary {
  const base = emptyRun(arch, id, label, faultAt)
  let state = freshState()
  const slo = sloOf(arch)
  let counters = zeroCounters()
  const steps = Math.round(seconds * 10)
  for (let i = 0; i <= steps; i++) {
    const out = step(arch, state, i === 0 ? 0 : 0.1, { shape, injected: injectedAt(state.t) })
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
    failing: live.filter((r) => !r.passes).map((r) => r.id as ScenarioId),
    cost: runs[0]?.cost ?? 0,
  }
}
