import { describe, expect, it } from 'vitest'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { linkShortener } from '../presets/linkShortener'

function run(seconds: number, shape: TrafficShape, injected?: Record<string, Injected>, arch = linkShortener) {
  let state = freshState()
  let last = step(arch, state, 0, { shape, injected })
  const samples: typeof last.result[] = []
  for (let i = 0; i < seconds * 10; i++) {
    last = step(arch, state, 0.1, { shape, injected })
    state = last.state
    samples.push(last.result)
  }
  return { last: last.result, samples }
}

describe('engine', () => {
  it('steady preset is healthy with no errors', () => {
    const { last } = run(20, 'steady')
    expect(last.totals.errorRate).toBeLessThan(0.001)
    expect(last.nodes.app.health).toBe('healthy')
    expect(last.totals.throughput).toBeGreaterThan(590)
  })

  it('cache hit rate shields the database', () => {
    const { last } = run(5, 'steady')
    expect(last.nodes.db.offered).toBeCloseTo(last.nodes.cache.offered * 0.2, 0)
  })

  it('a spike overloads the app tier and retries amplify it', () => {
    const { samples } = run(30, 'spike')
    const peak = samples[samples.length - 1]
    expect(peak.nodes.app.health).toBe('failed')
    expect(peak.totals.errorRate).toBeGreaterThan(0.3)
    expect(peak.totals.retryFactor).toBeGreaterThan(0.3)
  })

  it('recovers after the spike ends', () => {
    const { last } = run(58, 'spike')
    expect(last.totals.errorRate).toBeLessThan(0.05)
  })

  it('a killed database fails and drops its traffic', () => {
    const { last } = run(5, 'steady', { db: 'killed' })
    expect(last.nodes.db.health).toBe('failed')
    expect(last.nodes.db.dropped).toBeGreaterThan(50)
  })

  it('queue depth grows when arrivals exceed drain rate', () => {
    const arch = { ...linkShortener, components: [...linkShortener.components, { id: 'q', kind: 'queue' as const, name: 'Q', position: { col: 0, row: 9 }, config: { capacity: 50, maxDepth: 1000 } }], connections: [{ id: 'x', from: 'client', to: 'q' }] }
    const { last } = run(3, 'steady', undefined, arch)
    expect(last.nodes.q.queueDepth).toBeGreaterThan(100)
  })
})

describe('caches and the read/write mix', () => {
  const withMix = (readPct: number, cache: Record<string, number> = {}) => ({
    ...linkShortener,
    components: linkShortener.components.map((c) =>
      c.id === 'client' ? { ...c, config: { ...c.config, readPct } } : c.id === 'cache' ? { ...c, config: { ...c.config, ...cache } } : c),
  })

  it('leaves a design at the standard 90% read mix exactly as it was', () => {
    const { last } = run(10, 'steady')
    expect(last.nodes.cache.hit).toBeCloseTo(0.8, 5)
    expect(last.nodes.db.offered).toBeCloseTo(120, 3) // 600 rps, 20% misses
  })
  it('answers fewer requests the more of them are writes, because only reads can be cached', () => {
    const hit = (r: number) => run(10, 'steady', undefined, withMix(r)).last.nodes.cache.hit
    expect(hit(0.5)).toBeLessThan(hit(0.9))
    expect(hit(0.9)).toBeLessThan(hit(0.99))
    expect(hit(0.5)).toBeCloseTo(0.8 * (0.5 / 0.9), 3)
  })
  it('sends every write through to the database', () => {
    const { last } = run(10, 'steady', undefined, withMix(0.5, { hitRate: 0.9 }))
    expect(last.nodes.db.offered).toBeGreaterThanOrEqual(0.5 * 600 - 1) // the write half, at least, however good the cache
  })
  it('a write-heavy client puts more on the database than a read-heavy one with the same cache', () => {
    const load = (r: number) => run(10, 'steady', undefined, withMix(r)).last.nodes.db.offered
    expect(load(0.5)).toBeGreaterThan(load(0.9))
    expect(load(0.9)).toBeGreaterThan(load(0.99))
  })
  it('reports the hit rate on reads separately from the share of all requests answered', () => {
    const n = run(10, 'steady', undefined, withMix(0.5)).last.nodes.cache
    expect(n.readHit).toBeCloseTo(0.8 / 0.9, 3)
    expect(n.hit).toBeCloseTo(n.readHit! * 0.5, 3)
  })
  it('no request is lost or invented on the way through', () => {
    const { last } = run(10, 'steady', undefined, withMix(0.3))
    expect(last.nodes.cache.served).toBeCloseTo(last.nodes.cache.served * last.nodes.cache.hit + last.nodes.db.offered, 3)
  })
})
