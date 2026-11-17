import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { shareSlowerThan } from './latency'
import { linkShortener } from '../presets/linkShortener'
import type { Architecture } from '../store/types'

function run(arch: Architecture, seconds: number, shape: TrafficShape = 'steady', injected?: Record<string, Injected>) {
  let state = freshState()
  let last = step(arch, state, 0, { shape, injected })
  for (let i = 0; i < seconds * 10; i++) {
    last = step(arch, state, 0.1, { shape, injected })
    state = last.state
  }
  return last.result
}
const tweak = (arch: Architecture, id: string, config: Record<string, number>): Architecture => ({ ...arch, components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...config } } : c)) })

describe('latency distribution', () => {
  it('has no timeout when the limit is 0', () => expect(shareSlowerThan(50, 200, 0)).toBe(0))
  it('half the requests are slower than the median', () => expect(shareSlowerThan(50, 200, 50)).toBeCloseTo(0.5, 2))
  it('one percent are slower than the p99', () => expect(shareSlowerThan(50, 200, 200)).toBeCloseTo(0.01, 2))
  it('almost none are slower than a very generous limit', () => expect(shareSlowerThan(50, 200, 5000)).toBeLessThan(0.0001))
})

describe('retry policy', () => {
  const overload = tweak(linkShortener, 'client', { rps: 1400 }) // far beyond the app tier
  it('defaults behave exactly as before (two retries)', () => {
    expect(run(overload, 20).totals.retryFactor).toBeGreaterThan(0.5)
  })
  it('no retries means no retry storm', () => {
    expect(run(tweak(overload, 'client', { retries: 0 }), 20).totals.retryFactor).toBe(0)
  })
  it('more retries amplify the load more', () => {
    const few = run(tweak(overload, 'client', { retries: 1 }), 20).totals.retryFactor
    const many = run(tweak(overload, 'client', { retries: 5 }), 20).totals.retryFactor
    expect(many).toBeGreaterThan(few * 2)
  })
  it('backoff with jitter damps the retry storm', () => {
    const plain = run(overload, 20).totals.retryFactor
    const backoff = run(tweak(overload, 'client', { backoff: 1 }), 20).totals.retryFactor
    expect(backoff).toBeLessThan(plain * 0.6)
  })
})

describe('client timeouts', () => {
  it('are off by default: a slow database alone adds no timeout errors', () => {
    expect(run(linkShortener, 10, 'steady', { db: 'slow' }).totals.timeouts).toBe(0)
  })
  it('turn slow responses into errors', () => {
    const tight = tweak(linkShortener, 'client', { timeoutMs: 400 })
    const calm = run(tight, 10)
    expect(calm.totals.timeouts).toBeLessThan(0.01)
    const slow = run(tight, 10, 'steady', { db: 'slow' })
    expect(slow.totals.timeouts).toBeGreaterThan(0.02)
    expect(slow.totals.errorRate).toBeGreaterThan(calm.totals.errorRate)
  })
  it('timeouts feed retries', () => {
    const tight = tweak(linkShortener, 'client', { timeoutMs: 80 })
    expect(run(tight, 20, 'steady', { app: 'slow' }).totals.retryFactor).toBeGreaterThan(0.1)
  })
})

describe('backpressure', () => {
  const blocking = tweak(linkShortener, 'app', { blocking: 1 })
  it('is off by default: a slow database does not touch the app tier', () => {
    const r = run(linkShortener, 15, 'steady', { db: 'slow' })
    expect(r.nodes.app.hold).toBeUndefined()
    expect(r.nodes.app.capacity).toBe(1000)
  })
  it('does nothing while downstream is healthy', () => {
    const r = run(blocking, 15)
    expect(r.nodes.app.hold).toBeUndefined()
    expect(r.nodes.app.health).toBe('healthy')
  })
  it('a slow database holds app workers and cuts their capacity', () => {
    const r = run(blocking, 20, 'steady', { db: 'slow' })
    expect(r.nodes.app.hold).toBeGreaterThan(1.5)
    expect(r.nodes.app.capacity).toBeLessThan(700)
    expect(r.nodes.app.health).toBe('failed') // the app tier now fails even though nothing is wrong with it
  })
  it('a call timeout caps how long workers wait and fails the slow calls instead', () => {
    const waitForever = run(blocking, 25, 'steady', { db: 'slow' })
    const capped = run(tweak(blocking, 'app', { callTimeoutMs: 100 }), 25, 'steady', { db: 'slow' })
    expect(capped.nodes.app.hold!).toBeLessThan(waitForever.nodes.app.hold!)
    expect(capped.nodes.app.callTimeouts ?? 0).toBeGreaterThan(0)
  })
  it('the explanation names the downstream wait', () => {
    const r = run(blocking, 20, 'steady', { db: 'slow' })
    const arch = blocking
    const i = analyze(arch, r)!
    expect(i.reasons.join(' ')).toMatch(/waiting on|downstream/)
  })
})
