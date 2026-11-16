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
