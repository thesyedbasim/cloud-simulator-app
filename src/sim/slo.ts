/**
 * Service-level targets and the error budget. The budget is the failures the target allows; "used" is how
 * much of that allowance the run so far has consumed. Over 100% means the target is already missed.
 */
import type { Architecture, Slo } from '../store/types'

export type { Slo }
export const DEFAULT_SLO: Slo = { availability: 0.995, p99Ms: 500 }
export const AVAILABILITY_OPTIONS = [0.99, 0.995, 0.999, 0.9995, 0.9999]
export const P99_OPTIONS = [100, 200, 500, 1000, 2000]

export const sloOf = (a: Architecture): Slo => ({ ...DEFAULT_SLO, ...a.slo })

export const pctLabel = (availability: number) => `${(availability * 100).toFixed(availability >= 0.9995 ? 2 : 1)}%`

/** What has happened so far in this run. */
export interface Counters {
  /** Requests attempted. */
  req: number
  /** Requests that failed. */
  fail: number
  /** Simulated seconds in which p99 stayed within the latency target. */
  okSec: number
  /** Simulated seconds with traffic. */
  sec: number
}
export const zeroCounters = (): Counters => ({ req: 0, fail: 0, okSec: 0, sec: 0 })

export function accumulate(c: Counters, totals: { offered: number; errorRate: number; p99: number }, dt: number, slo: Slo): Counters {
  if (dt <= 0 || totals.offered <= 0) return c
  const req = totals.offered * dt
  return { req: c.req + req, fail: c.fail + req * totals.errorRate, okSec: c.okSec + (totals.p99 <= slo.p99Ms ? dt : 0), sec: c.sec + dt }
}

export type SloLevel = 'ok' | 'warn' | 'bad'
export interface SloStatus {
  /** Fraction of requests that succeeded in this run (1 before any traffic). */
  availability: number
  /** Share of the error budget consumed: 0 = untouched, 1 = used up, above 1 = the target is missed. */
  budgetUsed: number
  meetsAvailability: boolean
  /** Share of the run's time that p99 was within target (1 before any traffic). */
  latencyShare: number
  meetsLatency: boolean
  level: SloLevel
}

export function sloStatus(c: Counters, slo: Slo): SloStatus {
  const allowed = c.req * (1 - slo.availability)
  const budgetUsed = c.req === 0 ? 0 : allowed > 0 ? c.fail / allowed : c.fail > 0 ? Infinity : 0
  const availability = c.req === 0 ? 1 : 1 - c.fail / c.req
  const latencyShare = c.sec === 0 ? 1 : c.okSec / c.sec
  const meetsLatency = latencyShare >= 0.95
  return {
    availability,
    budgetUsed,
    meetsAvailability: budgetUsed <= 1,
    latencyShare,
    meetsLatency,
    level: budgetUsed > 1 || !meetsLatency ? 'bad' : budgetUsed >= 0.5 || latencyShare < 0.99 ? 'warn' : 'ok',
  }
}

/** How many times faster than the target allows the budget is burning right now (1 = exactly on budget). */
export const burnRate = (errorRate: number, slo: Slo) => errorRate / Math.max(1e-9, 1 - slo.availability)
