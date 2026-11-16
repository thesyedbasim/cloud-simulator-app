import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { sampleTrace, type Trace } from './trace'

function result(shape: TrafficShape = 'steady', injected?: Record<string, Injected>, seconds = 5) {
  let state = freshState()
  let last = step(linkShortener, state, 0, { shape, injected })
  for (let i = 0; i < seconds * 10; i++) { last = step(linkShortener, state, 0.1, { shape, injected }); state = last.state }
  return last.result
}
const many = (res: ReturnType<typeof result>, n = 2000, via?: string) => Array.from({ length: n }, (_, i) => sampleTrace(linkShortener, res, 1000 + i, via)!)

describe('request tracing', () => {
  const calm = result()
  it('starts at a client and follows real connections', () => {
    const t = sampleTrace(linkShortener, calm, 1)!
    expect(t.hops[0].kind).toBe('client')
    expect(t.hops.slice(0, 3).map((h) => h.nodeId)).toEqual(['client', 'lb', 'app'])
    t.edges.forEach((e, i) => {
      const edge = linkShortener.connections.find((c) => c.id === e)!
      expect(edge.from).toBe(t.hops[i].nodeId)
      expect(edge.to).toBe(t.hops[i + 1].nodeId)
    })
  })
  it('is reproducible for the same seed', () => {
    expect(sampleTrace(linkShortener, calm, 42)).toEqual(sampleTrace(linkShortener, calm, 42))
  })
  it('cache hits end the request early, at roughly the configured hit rate', () => {
    const ts = many(calm)
    const hits = ts.filter((t) => t.hops.some((h) => h.outcome === 'hit')).length / ts.length
    expect(hits).toBeGreaterThan(0.75)
    expect(hits).toBeLessThan(0.85)
    for (const t of ts.filter((x) => x.hops.some((h) => h.outcome === 'hit'))) expect(t.hops.some((h) => h.nodeId === 'db')).toBe(false)
  })
  it('a healthy system drops (almost) nothing', () => {
    expect(many(calm).filter((t) => t.outcome === 'dropped').length).toBeLessThan(5)
  })
  it('traces fail in proportion to the live error rate', () => {
    const spike = result('spike', undefined, 30)
    const failed = many(spike).filter((t) => t.outcome === 'dropped').length / 2000
    expect(failed).toBeGreaterThan(spike.totals.errorRate - 0.08)
    expect(failed).toBeLessThan(spike.totals.errorRate + 0.08)
  })
  it('a dead component fails every request that reaches it, and says why', () => {
    const dead = result('steady', { app: 'killed' })
    const t = sampleTrace(linkShortener, dead, 3)!
    expect(t.outcome).toBe('dropped')
    expect(t.failedAt).toBe('app')
    expect(t.summary).toMatch(/is down/)
  })
  it('can be steered through a chosen connection', () => {
    const t = sampleTrace(linkShortener, calm, 5, 'c4')!
    expect(t.edges).toContain('c4')
    expect(t.hops.some((h) => h.nodeId === 'db')).toBe(true)
  })
  it('totals the time spent at each hop', () => {
    const t = sampleTrace(linkShortener, calm, 9)! as Trace
    expect(t.totalMs).toBeCloseTo(t.hops.reduce((a, h) => a + h.ms, 0), 6)
  })
})
