import { describe, expect, it } from 'vitest'
import { freshState, step, type Injected } from './engine'
import { fanOutLatency, zOf } from './latency'
import { recoveryObjectives } from './review'
import { hourlyCost } from './capacity'
import { linkShortener } from '../presets/linkShortener'
import type { Architecture } from '../store/types'

const tweak = (arch: Architecture, id: string, config: Record<string, number>): Architecture => ({ ...arch, components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...config } } : c)) })
const settle = (arch: Architecture, seconds: number, plan: (t: number) => Record<string, Injected> | undefined = () => undefined) => {
  let state = freshState()
  let last = step(arch, state, 0, { shape: 'steady' })
  for (let i = 0; i < seconds * 10; i++) { last = step(arch, state, 0.1, { shape: 'steady', injected: plan(i / 10) }); state = last.state }
  return last.result
}

describe('normal curve helpers', () => {
  it('inverts the normal curve', () => {
    expect(zOf(0.5)).toBeCloseTo(0, 6)
    expect(zOf(0.99)).toBeCloseTo(2.3263, 3)
    expect(zOf(0.975)).toBeCloseTo(1.96, 3)
    expect(zOf(0.01)).toBeCloseTo(-2.3263, 3)
    expect(zOf(0.9999)).toBeCloseTo(3.719, 2)
  })
  it('one call is the baseline: median 1×, p99 4×', () => {
    const one = fanOutLatency(1)
    expect(one.p50).toBeCloseTo(1, 6)
    expect(one.p99).toBeCloseTo(4, 3)
  })
  it('waiting for the slowest of many calls stretches the tail, and then the middle too', () => {
    const f = [1, 2, 10, 50, 100].map((n) => fanOutLatency(n))
    for (let i = 1; i < f.length; i++) { expect(f[i].p99).toBeGreaterThan(f[i - 1].p99); expect(f[i].p50).toBeGreaterThan(f[i - 1].p50) }
    expect(f[4].p99 / f[0].p99).toBeGreaterThan(1.5)
    expect(f[4].p50).toBeGreaterThan(2) // with 100 calls the median request waits for a call that would be slow 1 time in 100
  })
})

describe('fan-out', () => {
  const p99 = (n: number) => settle(tweak(linkShortener, 'app', { fanout: n }), 5).totals.p99
  it('does nothing at 1 (the default)', () => {
    expect(settle(linkShortener, 5).totals.p99).toBeCloseTo(p99(1), 6)
    expect(settle(linkShortener, 5).nodes.app.fanout).toBeUndefined()
  })
  it('makes the p99 grow with the number of parallel calls', () => {
    expect(p99(10)).toBeGreaterThan(p99(1) * 1.05)
    expect(p99(100)).toBeGreaterThan(p99(10))
  })
  it('hurts the median less than the tail', () => {
    const base = settle(linkShortener, 5).totals
    const fan = settle(tweak(linkShortener, 'app', { fanout: 50 }), 5).totals
    expect(fan.p99 - base.p99).toBeGreaterThan(fan.p50 - base.p50)
  })
  it('reports the stretch on the tier', () => {
    expect(settle(tweak(linkShortener, 'app', { fanout: 50 }), 5).nodes.app.fanout!.tail).toBeGreaterThan(1.3)
  })
  it('does not change the load or the error rate (only latency is modelled)', () => {
    const a = settle(linkShortener, 5), b = settle(tweak(linkShortener, 'app', { fanout: 50 }), 5)
    expect(b.totals.errorRate).toBe(a.totals.errorRate)
    expect(b.nodes.db.offered).toBeCloseTo(a.nodes.db.offered, 6)
  })
})

describe('strong vs eventual consistency', () => {
  const replicated = (cfg: Record<string, number>) => tweak(linkShortener, 'db', { replicas: 2, replLagMs: 200, ...cfg })
  const readHeavy = (cfg: Record<string, number>) => tweak(replicated(cfg), 'client', { rps: 1000, readPct: 0.7 }) // enough writes to see the cost
  it('eventual (the default) can return stale reads', () => {
    expect(settle(replicated({}), 5).nodes.db.staleReads!).toBeGreaterThan(0.01)
  })
  it('strong never returns a stale read', () => {
    expect(settle(replicated({ consistency: 1 }), 5).nodes.db.staleReads).toBe(0)
  })
  it('strong sends every read to the primary, so it carries more load than with replicas sharing the reads', () => {
    const eventual = settle(readHeavy({}), 8).nodes.db
    const strong = settle(readHeavy({ consistency: 1 }), 8).nodes.db
    expect(strong.util).toBeGreaterThan(eventual.util * 1.2)
  })
  it('strong makes writes wait for a replica, so latency is higher', () => {
    const eventual = settle(readHeavy({}), 8).nodes.db
    const strong = settle(readHeavy({ consistency: 1 }), 8).nodes.db
    expect(strong.latency).toBeGreaterThan(eventual.latency)
  })
  it('strong loses no acknowledged writes in a failover; eventual does', () => {
    const kill = (t: number): Record<string, Injected> | undefined => (t >= 5 ? { db: 'killed' } : undefined)
    const lost = (cfg: Record<string, number>) => settle(replicated({ failoverSec: 10, replLagMs: 800, ...cfg }), 12, kill).nodes.db.failover!.lostWrites
    expect(lost({})).toBeGreaterThan(5)
    expect(lost({ consistency: 1 })).toBe(0)
  })
  it('costs nothing extra by itself', () => {
    expect(hourlyCost('database', { vcpu: 4, ramGb: 16, replicas: 2, consistency: 1 })).toBe(hourlyCost('database', { vcpu: 4, ramGb: 16, replicas: 2 }))
  })
})

describe('recovery objectives', () => {
  it('a lone database must be restored by hand and can lose everything', () => {
    const [r] = recoveryObjectives(linkShortener)
    expect(r.rtoSec).toBeNull()
    expect(r.rpoSec).toBeNull()
  })
  it('a replica gives an RTO of the failover time and an RPO of the idle lag', () => {
    const [r] = recoveryObjectives(tweak(linkShortener, 'db', { replicas: 1, failoverSec: 45, replLagMs: 250 }))
    expect(r.rtoSec).toBe(45)
    expect(r.rpoSec).toBeCloseTo(0.25, 6)
  })
  it('strong consistency brings the RPO to zero', () => {
    expect(recoveryObjectives(tweak(linkShortener, 'db', { replicas: 1, consistency: 1 }))[0].rpoSec).toBe(0)
  })
  it('lists every database and ignores the rest of the design', () => {
    expect(recoveryObjectives({ name: 'x', components: linkShortener.components.filter((c) => c.kind !== 'database'), connections: [] })).toEqual([])
  })
})
