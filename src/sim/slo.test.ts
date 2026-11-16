import { describe, expect, it } from 'vitest'
import { accumulate, burnRate, sloStatus, zeroCounters, DEFAULT_SLO, sloOf } from './slo'
import { linkShortener } from '../presets/linkShortener'
import { freshState, step } from './engine'

const slo = { availability: 0.99, p99Ms: 500 }
const run = (errorRate: number, p99: number, seconds: number, c = zeroCounters(), offered = 1000) => {
  for (let i = 0; i < seconds * 10; i++) c = accumulate(c, { offered, errorRate, p99 }, 0.1, slo)
  return c
}

describe('error budget', () => {
  it('starts untouched', () => {
    const s = sloStatus(zeroCounters(), slo)
    expect(s.budgetUsed).toBe(0)
    expect(s.availability).toBe(1)
    expect(s.level).toBe('ok')
  })
  it('a healthy run uses none of it', () => {
    expect(sloStatus(run(0, 100, 60), slo).budgetUsed).toBe(0)
  })
  it('consumes the budget in proportion to the failures the target allows', () => {
    // a 99% target allows 1% failures: running at 0.5% errors uses half of the allowance
    expect(sloStatus(run(0.005, 100, 60), slo).budgetUsed).toBeCloseTo(0.5, 6)
    expect(sloStatus(run(0.006, 100, 60), slo).level).toBe('warn') // 60% of the allowance
  })
  it('missing the target means more than 100% of the budget is gone', () => {
    const s = sloStatus(run(0.02, 100, 60), slo)
    expect(s.budgetUsed).toBeCloseTo(2, 6)
    expect(s.meetsAvailability).toBe(false)
    expect(s.level).toBe('bad')
    expect(s.availability).toBeCloseTo(0.98, 6)
  })
  it('a short outage in a long healthy run can still fit in the budget', () => {
    const c = run(0, 100, 540)
    const s = sloStatus(run(0.5, 100, 5, c), slo)
    expect(s.budgetUsed).toBeLessThan(1)
  })
  it('tracks how long latency stayed within target', () => {
    const c = run(0, 100, 50)
    const s = sloStatus(run(0, 900, 50, c), slo)
    expect(s.latencyShare).toBeCloseTo(0.5, 6)
    expect(s.meetsLatency).toBe(false)
    expect(s.level).toBe('bad')
  })
  it('ignores time with no traffic', () => {
    expect(run(0.9, 9999, 10, zeroCounters(), 0)).toEqual(zeroCounters())
  })
  it('burn rate says how many times faster than allowed the budget is going', () => {
    expect(burnRate(0.01, slo)).toBeCloseTo(1, 6)
    expect(burnRate(0.78, slo)).toBeCloseTo(78, 6)
  })
  it('designs without targets use the defaults', () => {
    expect(sloOf(linkShortener)).toEqual(DEFAULT_SLO)
    expect(sloOf({ ...linkShortener, slo: { availability: 0.999, p99Ms: 200 } })).toEqual({ availability: 0.999, p99Ms: 200 })
  })
  it('matches the live simulation: a spike on the starter design blows a 99.5% target', () => {
    let state = freshState()
    let c = zeroCounters()
    for (let i = 0; i < 600; i++) {
      const out = step(linkShortener, state, 0.1, { shape: 'spike' })
      state = out.state
      c = accumulate(c, out.result.totals, 0.1, DEFAULT_SLO)
    }
    expect(sloStatus(c, DEFAULT_SLO).meetsAvailability).toBe(false)
  })
})
