import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { PRESETS } from '../presets/index'
import { equilibrium, findCapacity } from './finder'
import type { Architecture } from '../store/types'

const withApp = (patch: Record<string, number>): Architecture => ({
  ...linkShortener,
  components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, ...patch } } : c)),
})

describe('capacity finder', () => {
  const r = findCapacity(linkShortener)!

  it('finds the load at which the app tier saturates', () => {
    // 2 app instances × 500 rps = 1,000 rps is the first limit in the chain
    expect(r.maxRps).toBeGreaterThan(960)
    expect(r.maxRps).toBeLessThan(1040)
    expect(r.multiple).toBeCloseTo(r.maxRps! / 600, 6)
    expect(r.currentRps).toBe(600)
  })

  it('agrees with the engine: just below the limit is clean, just above is not', () => {
    const below = equilibrium(linkShortener, r.multiple * 0.97)
    const above = equilibrium(linkShortener, r.multiple * 1.1)
    expect(below.totals.errorRate).toBeLessThan(0.001)
    expect(above.totals.errorRate).toBeGreaterThan(0.02)
  })

  it('names the part that gives out first, with the same explanation as the live card', () => {
    expect(r.headroom[0].id).toBe('app')
    expect(r.headroom[0].multiple).toBeCloseTo(1000 / 600, 1)
    expect(r.breaksBecause?.nodeId).toBe('app')
  })

  it('lists headroom for every non-client component, tightest first', () => {
    expect(r.headroom).toHaveLength(4)
    for (let i = 1; i < r.headroom.length; i++) expect(r.headroom[i].multiple).toBeGreaterThanOrEqual(r.headroom[i - 1].multiple)
  })

  it('more instances raise the limit; autoscaling raises it further', () => {
    const more = findCapacity(withApp({ instances: 4 }))!
    expect(more.maxRps!).toBeGreaterThan(r.maxRps! * 1.5)
    const auto = findCapacity(withApp({ autoscale: 1, maxInstances: 8, warmupSec: 5 }))!
    expect(auto.maxRps!).toBeGreaterThan(r.maxRps! * 1.5)
  })

  it('the curve shows errors rising as load passes the limit', () => {
    expect(r.curve.length).toBeGreaterThan(10)
    const early = r.curve.filter((p) => p.rps < r.maxRps! * 0.9)
    const late = r.curve.filter((p) => p.rps > r.maxRps! * 1.2)
    expect(Math.max(...early.map((p) => p.err))).toBeLessThan(1)
    expect(Math.max(...late.map((p) => p.err))).toBeGreaterThan(5)
  })

  it('reports a design that is already overloaded as having a limit below today\'s load', () => {
    const hot = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'client' ? { ...c, config: { ...c.config, rps: 2000 } } : c)) }
    const h = findCapacity(hot)!
    expect(h.multiple).toBeLessThan(1)
    expect(h.maxRps!).toBeGreaterThan(900)
    expect(h.maxRps!).toBeLessThan(1100)
  })

  it('has nothing to say about a design with no traffic path', () => {
    expect(findCapacity({ ...linkShortener, connections: [] })).toBeNull()
  })

  it('works on every starter design', () => {
    for (const p of PRESETS) {
      const rep = findCapacity(p.arch)!
      expect(rep.maxRps ?? Infinity).toBeGreaterThan(0)
      expect(rep.headroom.length).toBeGreaterThan(0)
    }
  })
})
