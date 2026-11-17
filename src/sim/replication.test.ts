import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { findSpofs } from './review'
import { linkShortener } from '../presets/linkShortener'
import type { Architecture } from '../store/types'

const withDb = (cfg: Record<string, number>, clientCfg: Record<string, number> = {}): Architecture => ({
  ...linkShortener,
  components: linkShortener.components.map((c) => (c.id === 'db' ? { ...c, config: { ...c.config, ...cfg } } : c.id === 'client' ? { ...c, config: { ...c.config, ...clientCfg } } : c)),
})

function run(arch: Architecture, seconds: number, shape: TrafficShape = 'steady', injectedAt?: { at: number; injected: Record<string, Injected> }) {
  let state = freshState()
  let last = step(arch, state, 0, { shape })
  const samples: typeof last.result[] = []
  for (let i = 0; i < seconds * 10; i++) {
    const injected = injectedAt && i / 10 >= injectedAt.at ? injectedAt.injected : undefined
    last = step(arch, state, 0.1, { shape, injected })
    state = last.state
    samples.push(last.result)
  }
  return { last: last.result, samples }
}

describe('replication lag', () => {
  it('does not exist without replicas', () => {
    const n = run(withDb({}), 5).last.nodes.db
    expect(n.lagMs).toBeUndefined()
    expect(n.staleReads).toBeUndefined()
  })
  it('is the idle lag when the primary is quiet', () => {
    const n = run(withDb({ replicas: 1, replLagMs: 100 }), 5).last.nodes.db
    expect(n.lagMs!).toBeGreaterThanOrEqual(100)
    expect(n.lagMs!).toBeLessThan(150)
  })
  it('grows as the primary gets busier', () => {
    const calm = run(withDb({ replicas: 1, replLagMs: 100 }), 5).last.nodes.db
    const busy = run(withDb({ replicas: 1, replLagMs: 100 }, { rps: 900, readPct: 0.2 }), 5).last.nodes.db
    expect(busy.util).toBeGreaterThan(calm.util)
    expect(busy.lagMs!).toBeGreaterThan(calm.lagMs! * 1.5)
  })
  it('more lag and more replicas mean more stale reads', () => {
    const lowLag = run(withDb({ replicas: 1, replLagMs: 20 }), 5).last.nodes.db.staleReads!
    const highLag = run(withDb({ replicas: 1, replLagMs: 1500 }), 5).last.nodes.db.staleReads!
    const moreReplicas = run(withDb({ replicas: 3, replLagMs: 1500 }), 5).last.nodes.db.staleReads!
    expect(highLag).toBeGreaterThan(lowLag * 5)
    expect(moreReplicas).toBeGreaterThan(highLag)
  })
})

describe('failover', () => {
  const kill = { at: 5, injected: { db: 'killed' as const } }
  it('a lone database that dies stays down', () => {
    const { last } = run(withDb({}), 60, 'steady', kill)
    expect(last.nodes.db.down).toBe(true)
    expect(last.nodes.db.failover).toBeUndefined()
  })
  it('with a replica, writes fail but reads survive during the failover window', () => {
    const { samples } = run(withDb({ replicas: 1, failoverSec: 30 }, { readPct: 0.8 }), 20, 'steady', kill)
    const n = samples[samples.length - 1].nodes.db
    expect(n.failover?.phase).toBe('failing')
    expect(n.failover!.remainingSec).toBeGreaterThan(10)
    expect(n.down).toBe(false)
    expect(n.served / n.offered).toBeGreaterThan(0.75)
    expect(n.served / n.offered).toBeLessThan(0.85) // roughly the read share
    expect(n.health).toBe('failed')
  })
  it('a replica is promoted once the failover time has passed, and the database recovers', () => {
    const { last } = run(withDb({ replicas: 1, failoverSec: 10 }), 30, 'steady', kill)
    expect(last.nodes.db.failover?.phase).toBe('promoted')
    expect(last.nodes.db.down).toBe(false)
    expect(last.nodes.db.dropped).toBeLessThan(1)
    expect(last.totals.errorRate).toBeLessThan(0.02)
  })
  it('promoting uses up a replica', () => {
    const { last } = run(withDb({ replicas: 1, failoverSec: 10 }), 30, 'steady', kill)
    expect(last.nodes.db.lagMs).toBeUndefined() // no replica left to lag
  })
  it('a longer failover time means a longer outage', () => {
    const errSeconds = (failoverSec: number) => run(withDb({ replicas: 1, failoverSec }), 60, 'steady', kill).samples.filter((s) => s.nodes.db.dropped > 1).length / 10
    expect(errSeconds(40)).toBeGreaterThan(errSeconds(10) + 15)
  })
  it('loses the writes that had not been replicated yet', () => {
    const lagged = run(withDb({ replicas: 1, replLagMs: 1000, failoverSec: 10 }), 20, 'steady', kill).last.nodes.db.failover!.lostWrites
    const tight = run(withDb({ replicas: 1, replLagMs: 10, failoverSec: 10 }), 20, 'steady', kill).last.nodes.db.failover!.lostWrites
    expect(lagged).toBeGreaterThan(tight * 5)
    expect(lagged).toBeGreaterThan(0)
  })
  it('is explained as a failover, with the lost writes', () => {
    const arch = withDb({ replicas: 1, replLagMs: 1000, failoverSec: 30 })
    const { last } = run(arch, 15, 'steady', kill)
    const i = analyze(arch, last)!
    expect(i.title).toMatch(/failing over/)
    expect(i.reasons.join(' ')).toMatch(/lost for good/)
  })
  it('restoring the primary during the window clears the failover', () => {
    const arch = withDb({ replicas: 1, failoverSec: 30 })
    let state = freshState()
    for (let i = 0; i < 100; i++) state = step(arch, state, 0.1, { shape: 'steady', injected: { db: 'killed' } }).state
    expect(state.killedAt.db).toBeDefined()
    state = step(arch, state, 0.1, { shape: 'steady' }).state
    expect(state.killedAt.db).toBeUndefined()
  })
})

describe('single points of failure', () => {
  it('a database with a replica is no longer a single point of failure', () => {
    expect(findSpofs(linkShortener).some((s) => s.id === 'db')).toBe(true)
    expect(findSpofs(withDb({ replicas: 1 })).some((s) => s.id === 'db')).toBe(false)
  })
})
