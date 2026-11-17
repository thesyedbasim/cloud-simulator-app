import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step } from './engine'
import { runScenario, runSuite } from './headless'
import { planScenario, SCENARIOS, SUITE_IDS } from './scenarios'
import { linkShortener } from '../presets/linkShortener'
import { PRESETS } from '../presets/index'
import type { Architecture } from '../store/types'

const tweak = (arch: Architecture, id: string, config: Record<string, number>): Architecture => ({ ...arch, components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...config } } : c)) })

describe('scenario plans', () => {
  it('every scenario has a plan for the starter presets (or says why not)', () => {
    for (const p of PRESETS) for (const s of SCENARIOS) {
      const plan = planScenario(p.arch, s.id)
      expect(plan.empty !== undefined || Object.keys(plan.injections).length > 0 || s.id === 'spike').toBe(true)
    }
  })
  it('say what is missing on an empty design', () => {
    const empty = { name: 'x', components: [], connections: [] }
    for (const id of ['cacheFlush', 'retryStorm', 'zoneOutage', 'grayFailure', 'badDeploy', 'thunderingHerd'] as const) expect(planScenario(empty, id).empty).toBeTruthy()
  })
  it('flushes every cache and CDN', () => {
    expect(planScenario(linkShortener, 'cacheFlush').injections).toEqual({ cache: 'flushed' })
  })
  it('a zone outage takes out half of each server tier and the database primary', () => {
    expect(planScenario(linkShortener, 'zoneOutage').injections).toEqual({ app: 'zoneLoss', db: 'killed' })
  })
  it('retry storm and thundering herd are brief; the others are lasting', () => {
    expect(planScenario(linkShortener, 'retryStorm').until).toBe(15)
    expect(planScenario(linkShortener, 'thunderingHerd').until).toBe(13)
    expect(planScenario(linkShortener, 'badDeploy').until).toBeUndefined()
  })
  it('the stress suite still runs only the original three', () => {
    expect(SUITE_IDS).toEqual(['spike', 'nodeFailure', 'slowDb'])
    expect(runSuite(linkShortener).runs.map((r) => r.id)).toEqual(SUITE_IDS)
  })
})

describe('cache flush', () => {
  it('overloads the database behind a cache', () => {
    expect(runScenario(linkShortener, 'cacheFlush').peakErr).toBeGreaterThan(0.5)
  })
  it('request coalescing softens it', () => {
    const plain = runScenario(linkShortener, 'cacheFlush')
    const coalesced = runScenario(tweak(linkShortener, 'cache', { coalesce: 1 }), 'cacheFlush')
    expect(coalesced.peakErr).toBeLessThan(plain.peakErr)
    expect(coalesced.errSeconds).toBeLessThan(plain.errSeconds)
  })
  it('recovers once the cache is warm again', () => {
    const r = runScenario(linkShortener, 'cacheFlush', 80)
    expect(r.err[r.err.length - 1]).toBeLessThan(2)
  })
})

describe('retry storm', () => {
  it('ends when the slowdown ends, and retries made it worse while it lasted', () => {
    const r = runScenario(linkShortener, 'retryStorm')
    expect(r.err[4]).toBeLessThan(1)
    expect(r.peakErr).toBeGreaterThan(0.5)
    expect(r.err[r.err.length - 1]).toBeLessThan(1)
  })
  it('clients that never retry see a shorter outage than ones that retry five times', () => {
    const calm = runScenario(tweak(linkShortener, 'client', { retries: 0 }), 'retryStorm')
    const storm = runScenario(tweak(linkShortener, 'client', { retries: 5 }), 'retryStorm')
    expect(storm.errSeconds).toBeGreaterThanOrEqual(calm.errSeconds)
    expect(storm.peakErr).toBeGreaterThanOrEqual(calm.peakErr)
  })
})

describe('zone outage', () => {
  it('halves a scaled-out tier', () => {
    const four = tweak(linkShortener, 'app', { instances: 4 })
    let state = freshState()
    let r = step(four, state, 0, { shape: 'steady', injected: { app: 'zoneLoss' } }).result
    for (let i = 0; i < 20; i++) { const o = step(four, state, 0.1, { shape: 'steady', injected: { app: 'zoneLoss' } }); state = o.state; r = o.result }
    expect(r.nodes.app.capacity).toBe(1000) // 2 of 4 instances × 500
    expect(r.nodes.app.down).toBe(false)
  })
  it('a database with a replica survives it, one without does not', () => {
    const replicated = tweak(linkShortener, 'db', { replicas: 1, failoverSec: 10 })
    const withReplica = runScenario(replicated, 'zoneOutage', 90)
    const without = runScenario(linkShortener, 'zoneOutage', 90)
    expect(withReplica.err[withReplica.err.length - 1]).toBeLessThan(without.err[without.err.length - 1])
  })
  it('is explained as lost capacity', () => {
    let state = freshState()
    let r = step(linkShortener, state, 0, { shape: 'steady' }).result
    for (let i = 0; i < 30; i++) { const o = step(linkShortener, state, 0.1, { shape: 'steady', injected: { app: 'zoneLoss' } }); state = o.state; r = o.result }
    const i = analyze({ ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 2 } } : c)) }, r)
    if (i) expect(i.reasons.join(' ')).toMatch(/failure zone/)
  })
})

describe('bad deploy', () => {
  it('fails about 30% of requests while the tier has plenty of capacity', () => {
    const r = runScenario(linkShortener, 'badDeploy')
    expect(r.peakErr).toBeGreaterThan(0.28)
    expect(r.peakErr).toBeLessThan(0.45)
  })
  it('is explained as a bad release, not as overload', () => {
    let state = freshState()
    let r = step(linkShortener, state, 0, { shape: 'steady' }).result
    for (let i = 0; i < 30; i++) { const o = step(linkShortener, state, 0.1, { shape: 'steady', injected: { app: 'bad' } }); state = o.state; r = o.result }
    const i = analyze(linkShortener, r)!
    expect(i.title).toMatch(/bad release/)
  })
  it('rolling back (restoring) clears it', () => {
    let state = freshState()
    let r = step(linkShortener, state, 0, { shape: 'steady' }).result
    for (let i = 0; i < 20; i++) { const o = step(linkShortener, state, 0.1, { shape: 'steady', injected: { app: 'bad' } }); state = o.state; r = o.result }
    expect(r.totals.errorRate).toBeGreaterThan(0.2)
    for (let i = 0; i < 100; i++) { const o = step(linkShortener, state, 0.1, { shape: 'steady' }); state = o.state; r = o.result }
    expect(r.totals.errorRate).toBeLessThan(0.01)
  })
})

describe('gray failure and thundering herd', () => {
  it('a gray failure is not detected: the balancer keeps sending traffic to the slow tier', () => {
    let state = freshState()
    let r = step(linkShortener, state, 0, { shape: 'steady' }).result
    for (let i = 0; i < 100; i++) { const o = step(linkShortener, state, 0.1, { shape: 'steady', injected: { app: 'slow' } }); state = o.state; r = o.result }
    expect(r.edges.c2.rps).toBeGreaterThan(300) // c2 is lb → app: still receiving its share
    expect(r.nodes.app.latency).toBeGreaterThan(100)
  })
  it('the herd hits a cold cache, which makes it worse than a plain restart', () => {
    const herd = runScenario(linkShortener, 'thunderingHerd')
    const coalesced = runScenario(tweak(linkShortener, 'cache', { coalesce: 1 }), 'thunderingHerd')
    expect(herd.peakErr).toBeGreaterThan(0.9)
    expect(coalesced.errSeconds).toBeLessThanOrEqual(herd.errSeconds)
  })
  it('recovers after the servers return and the cache warms', () => {
    const r = runScenario(linkShortener, 'thunderingHerd', 90)
    expect(r.err[r.err.length - 1]).toBeLessThan(2)
  })
})
