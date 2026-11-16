/**
 * Capacity finder: how much load can this design take before it breaks, and what gives out first?
 * It scales every client's traffic by a factor, lets the system settle, and searches for the largest factor
 * that still runs clean. Same engine as everything else, so the answer matches what you would see by turning
 * the traffic up yourself.
 */
import type { Architecture } from '../store/types'
import { configValue } from '../store/types'
import { freshState, step, type StepResult } from './engine'
import { analyze, type Insight } from './insight'
import { PASS_ERR } from './headless'

export interface Headroom {
  id: string
  name: string
  /** How many times today's load this component can take on its own (capacity ÷ offered). */
  multiple: number
  offered: number
  capacity: number
}

export interface CapacityReport {
  /** Total client requests per second today. */
  currentRps: number
  /** The largest load that still runs clean (null if no scale up to MAX_MULTIPLE ever breaks it). */
  maxRps: number | null
  /** maxRps ÷ currentRps. May be below 1 if the design is already overloaded. */
  multiple: number
  /** True when the design survives the biggest load tried, so the real limit is higher. */
  capped: boolean
  /** Why it breaks just above the limit, from the same explainer as the live card. */
  breaksBecause: Insight | null
  /** Components ordered by how little headroom they have. */
  headroom: Headroom[]
  /** Steady-state errors and p99 across a range of loads, for the chart. */
  curve: { rps: number; err: number; p99: number }[]
}

const MAX_MULTIPLE = 64
const MIN_MULTIPLE = 0.01

function scaled(arch: Architecture, m: number): Architecture {
  return { ...arch, components: arch.components.map((c) => (c.kind === 'client' ? { ...c, config: { ...c.config, rps: (c.config.rps ?? 0) * m } } : c)) }
}

/** Long enough for retries to settle and for autoscaling to finish starting its instances. */
function settleSeconds(arch: Architecture) {
  const warm = Math.max(0, ...arch.components.filter((c) => c.kind === 'appServers' && (configValue('appServers', c.config, 'autoscale') ?? 0) >= 0.5).map((c) => configValue('appServers', c.config, 'warmupSec') ?? 20))
  return Math.min(240, Math.max(60, warm * 3))
}

/** The state the design settles into at a steady load, `m` times today's. */
export function equilibrium(arch: Architecture, m: number, seconds = settleSeconds(arch)): StepResult {
  const a = scaled(arch, m)
  let state = freshState()
  let res = step(a, state, 0, { shape: 'steady' }).result
  for (let i = 0; i < seconds * 10; i++) {
    const out = step(a, state, 0.1, { shape: 'steady' })
    state = out.state
    res = out.result
  }
  return res
}

const clean = (r: StepResult) => r.totals.errorRate <= PASS_ERR && !Object.values(r.nodes).some((n) => n.health === 'failed')

export function findCapacity(arch: Architecture): CapacityReport | null {
  const clients = arch.components.filter((c) => c.kind === 'client')
  const currentRps = clients.reduce((a, c) => a + (c.config.rps ?? 0), 0)
  if (!clients.length || currentRps <= 0 || !arch.connections.some((e) => clients.some((c) => c.id === e.from))) return null

  const ok = (m: number) => clean(equilibrium(arch, m))

  // bracket the limit: double from today's load until it breaks (or halve until it works)
  let lo: number, hi: number
  let capped = false
  if (ok(1)) {
    lo = 1
    hi = 2
    while (ok(hi)) {
      lo = hi
      hi *= 2
      if (hi > MAX_MULTIPLE) { capped = true; break }
    }
  } else {
    hi = 1
    lo = 0.5
    while (!ok(lo)) {
      hi = lo
      lo /= 2
      if (lo < MIN_MULTIPLE) { lo = 0; break }
    }
  }
  if (!capped) for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) lo = mid
    else hi = mid
  }
  const limit = lo
  const maxRps = capped ? null : currentRps * limit

  // what gives out first, and how much room each part has today
  const today = equilibrium(arch, 1)
  const headroom: Headroom[] = arch.components
    .filter((c) => c.kind !== 'client')
    .map((c) => {
      const n = today.nodes[c.id]
      const offered = n?.offered ?? 0
      return { id: c.id, name: c.name, offered, capacity: n?.capacity ?? 0, multiple: offered > 0 ? (n?.capacity ?? 0) / offered : Infinity }
    })
    .sort((a, b) => a.multiple - b.multiple)

  const breaksBecause = capped ? null : analyze(scaled(arch, limit * 1.15), equilibrium(arch, limit * 1.15))

  // the curve: from a fraction of the limit to well past it
  const top = (capped ? MAX_MULTIPLE : limit) * 1.8
  const points = 26
  const curve = Array.from({ length: points }, (_, i) => {
    const m = Math.max(MIN_MULTIPLE, (top * (i + 1)) / points)
    const r = equilibrium(arch, m, Math.min(60, settleSeconds(arch)))
    return { rps: currentRps * m, err: r.totals.errorRate * 100, p99: r.totals.p99 }
  })

  return { currentRps, maxRps, multiple: limit, capped, breaksBecause, headroom, curve }
}
