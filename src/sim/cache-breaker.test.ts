import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step, type Injected } from './engine'
import { linkShortener } from '../presets/linkShortener'
import type { Architecture } from '../store/types'

const tweak = (arch: Architecture, id: string, config: Record<string, number>): Architecture => ({ ...arch, components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...config } } : c)) })

/** Runs the design, applying `plan(t)` as the injected faults at each step. */
function run(arch: Architecture, seconds: number, plan: (t: number) => Record<string, Injected> | undefined = () => undefined) {
  let state = freshState()
  let last = step(arch, state, 0, { shape: 'steady' })
  const samples: typeof last.result[] = []
  for (let i = 0; i < seconds * 10; i++) {
    last = step(arch, state, 0.1, { shape: 'steady', injected: plan(i / 10) })
    state = last.state
    samples.push(last.result)
  }
  return { last: last.result, samples, state }
}
const at = (s: ReturnType<typeof run>, sec: number) => s.samples[Math.round(sec * 10) - 1]
const flushAt5 = (t: number): Record<string, Injected> | undefined => (t >= 5 ? { cache: 'flushed' } : undefined)

describe('cold cache', () => {
  it('a design that never flushes behaves as before (always fully warm)', () => {
    const r = run(linkShortener, 10).last.nodes.cache
    expect(r.warmth).toBe(1)
    expect(r.hit).toBeCloseTo(0.8, 5)
  })
  it('a flush empties the cache at once', () => {
    const r = run(linkShortener, 5.5, flushAt5)
    expect(at(r, 5.5).nodes.cache.hit).toBeLessThan(0.1)
    expect(at(r, 5.5).nodes.db.offered).toBeGreaterThan(at(r, 4.5).nodes.db.offered * 3)
  })
  it('refills over the warm-up time', () => {
    const arch = tweak(linkShortener, 'cache', { warmSec: 20 })
    const r = run(arch, 40, flushAt5)
    expect(at(r, 15).nodes.cache.warmth!).toBeGreaterThan(0.4)
    expect(at(r, 15).nodes.cache.warmth!).toBeLessThan(0.6)
    expect(at(r, 39).nodes.cache.warmth).toBe(1)
    expect(at(r, 39).nodes.cache.hit).toBeCloseTo(0.8, 2)
  })
  it('the flush happens once even though the fault stays injected', () => {
    const arch = tweak(linkShortener, 'cache', { warmSec: 10 })
    expect(at(run(arch, 30, flushAt5), 29).nodes.cache.warmth).toBe(1)
  })
  it('a longer warm-up means a longer database overload', () => {
    const overloaded = (warmSec: number) => run(tweak(linkShortener, 'cache', { warmSec }), 80, flushAt5).samples.filter((s) => s.nodes.db.health === 'failed').length
    expect(overloaded(60)).toBeGreaterThan(overloaded(10))
  })
  it('flushing again after it recovered starts cold again', () => {
    const arch = tweak(linkShortener, 'cache', { warmSec: 5 })
    const r = run(arch, 30, (t) => (t >= 5 && t < 6) || t >= 20 ? { cache: 'flushed' } : undefined)
    expect(at(r, 15).nodes.cache.warmth).toBe(1)
    expect(at(r, 20.5).nodes.cache.warmth!).toBeLessThan(0.3)
  })
})

describe('stampede', () => {
  it('without coalescing a cold cache multiplies its misses, with it they do not', () => {
    const plain = run(linkShortener, 6, flushAt5)
    const coalesced = run(tweak(linkShortener, 'cache', { coalesce: 1 }), 6, flushAt5)
    expect(at(plain, 5.2).nodes.cache.stampede!).toBeGreaterThan(2.5)
    expect(at(coalesced, 5.2).nodes.cache.stampede).toBe(1)
    expect(at(plain, 5.2).nodes.db.offered).toBeGreaterThan(at(coalesced, 5.2).nodes.db.offered * 2)
  })
  it('no stampede when the cache is warm', () => {
    expect(run(linkShortener, 5).last.nodes.cache.stampede).toBe(1)
  })
  it('the explanation names the cold cache and the stampede', () => {
    const r = run(linkShortener, 8, flushAt5)
    const i = analyze(linkShortener, r.last)!
    expect(i.nodeId).toBe('db')
    expect(i.reasons.join(' ')).toMatch(/warm after a flush/)
    expect(i.reasons.join(' ')).toMatch(/coalescing/)
  })
  it('coalescing keeps the database in better shape during a flush', () => {
    const worst = (arch: Architecture) => Math.max(...run(arch, 40, flushAt5).samples.map((s) => s.nodes.db.util))
    expect(worst(tweak(linkShortener, 'cache', { coalesce: 1 }))).toBeLessThan(worst(linkShortener))
  })
})

describe('circuit breaker', () => {
  const slowDb = (t: number): Record<string, Injected> | undefined => (t >= 5 && t < 40 ? { db: 'slow' } : undefined)
  const withBreaker = (extra: Record<string, number> = {}) => tweak(linkShortener, 'app', { breaker: 1, breakerErrPct: 0.05, breakerOpenSec: 8, ...extra })

  it('is off by default and changes nothing', () => {
    expect(run(linkShortener, 20, slowDb).last.nodes.app.breaker).toBeUndefined()
  })
  it('stays closed while the downstream is fine', () => {
    const r = run(withBreaker(), 20)
    expect(r.last.nodes.app.breaker).toBe('closed')
    expect(r.last.totals.errorRate).toBeLessThan(0.001)
  })
  it('opens when downstream calls keep failing, and then sheds load', () => {
    const r = run(withBreaker(), 25, slowDb)
    const open = r.samples.find((s) => s.nodes.app.breaker === 'open')
    expect(open).toBeDefined()
    expect(open!.nodes.app.dropped).toBeGreaterThan(0)
    expect(open!.nodes.cache.offered).toBe(0) // nothing is sent downstream while open
  })
  it('protects the database: it sees far less traffic than without a breaker', () => {
    const dbLoad = (arch: Architecture) => run(arch, 30, slowDb).samples.slice(150).reduce((a, s) => a + s.nodes.db.offered, 0)
    expect(dbLoad(withBreaker())).toBeLessThan(dbLoad(linkShortener) * 0.6)
  })
  it('tries again after the open time and closes once the downstream is healthy', () => {
    const r = run(withBreaker({ breakerOpenSec: 5 }), 60, slowDb)
    const states = r.samples.map((s) => s.nodes.app.breaker)
    expect(states).toContain('open')
    expect(states).toContain('half')
    expect(r.last.nodes.app.breaker).toBe('closed')
    expect(r.last.totals.errorRate).toBeLessThan(0.02)
  })
  it('keeps cycling while the downstream is still unhealthy (a small test trickle can look fine)', () => {
    const r = run(withBreaker({ breakerOpenSec: 4 }), 30, slowDb)
    let opens = 0
    let prevState = ''
    for (const x of r.samples) { const b = x.nodes.app.breaker!; if (b === 'open' && prevState !== 'open') opens++; prevState = b }
    expect(opens).toBeGreaterThanOrEqual(2)
  })
  it('frees blocked workers: capacity recovers faster than waiting on a slow database', () => {
    const blocking = tweak(linkShortener, 'app', { blocking: 1 })
    const both = withBreaker({ blocking: 1 })
    const holdAt = (arch: Architecture) => at(run(arch, 25, slowDb), 24).nodes.app.hold ?? 1
    expect(holdAt(both)).toBeLessThan(holdAt(blocking))
  })
  it('is explained as load shedding', () => {
    const arch = withBreaker()
    const r = run(arch, 12, slowDb)
    const open = r.samples.filter((s) => s.nodes.app.breaker === 'open').pop()!
    const i = analyze(arch, open)!
    expect(i.title).toMatch(/shedding load/)
  })
})
