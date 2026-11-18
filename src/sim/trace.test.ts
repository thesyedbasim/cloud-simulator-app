import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import type { Architecture } from '../store/types'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { findTrace, sampleTrace, sampleTraces, type Trace } from './trace'

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
    expect(t.totalMs).toBeCloseTo(t.hops.reduce((a, h) => a + h.ms + h.netMs, 0), 6)
  })
})

describe('trace options', () => {
  const calm = result()
  const hot = result('spike', { app: 'killed' as Injected }, 8)
  it('starts from the chosen client', () => {
    expect(sampleTrace(linkShortener, calm, 7, undefined, 'client')!.hops[0].nodeId).toBe('client')
  })
  it('finds a failing request when something is failing', () => {
    const r = findTrace(linkShortener, hot, 3, { outcome: 'fail', type: 'any' })
    expect(r.matched).toBe(true)
    expect(r.trace!.outcome).toBe('dropped')
  })
  it('says so when no request fails, and still returns a trace', () => {
    const r = findTrace(linkShortener, calm, 3, { outcome: 'fail', type: 'any' })
    expect(r.matched).toBe(false)
    expect(r.trace).not.toBeNull()
  })
  it('a slow request is slower than a typical one', () => {
    const slow = findTrace(linkShortener, calm, 5, { outcome: 'slow', type: 'any' })
    const typical = Array.from({ length: 200 }, (_, i) => sampleTrace(linkShortener, calm, 900 + i)!.totalMs).sort((a, b) => a - b)[100]
    expect(slow.matched).toBe(true)
    expect(slow.trace!.totalMs).toBeGreaterThan(typical)
  })
  it('summarises many requests consistently', () => {
    const s = sampleTraces(linkShortener, hot, 11, 100)!
    expect(s.ok + s.dropped + s.blocked).toBe(s.n)
    expect(s.n).toBe(100)
    expect(s.failures.reduce((a, f) => a + f.count, 0)).toBe(s.dropped)
    expect(s.p99).toBeGreaterThanOrEqual(s.p50)
  })
})

describe('request types', () => {
  const calm = result()
  const cacheHops = (type: 'read' | 'write' | 'upload', n = 600) =>
    Array.from({ length: n }, (_, i) => sampleTrace(linkShortener, calm, 500 + i, undefined, undefined, type)!).flatMap((t) => t.hops.filter((h) => h.kind === 'cache'))

  it('reads are answered by the cache at about its hit rate', () => {
    const hops = cacheHops('read')
    const hits = hops.filter((h) => h.outcome === 'hit').length / hops.length
    expect(hits).toBeGreaterThan(0.7)
    expect(hits).toBeLessThan(0.9)
  })
  it('writes and uploads are never answered by the cache', () => {
    for (const type of ['write', 'upload'] as const) {
      const hops = cacheHops(type)
      expect(hops.length).toBeGreaterThan(0)
      expect(hops.some((h) => h.outcome === 'hit')).toBe(false)
      expect(hops[0].note).toContain('not cacheable')
    }
  })
  it('writes reach the database every time', () => {
    const ts = Array.from({ length: 200 }, (_, i) => sampleTrace(linkShortener, calm, 800 + i, undefined, undefined, 'write')!)
    expect(ts.every((t) => t.hops[t.hops.length - 1].kind === 'database')).toBe(true)
    expect(ts[0].type).toBe('write')
  })
  it('an upload heads for storage when the design has a bucket', () => {
    const withBucket: Architecture = {
      ...linkShortener,
      components: [...linkShortener.components, { id: 'files', kind: 'bucket', name: 'Files', position: { col: 12, row: 3 }, config: {} }],
      connections: [...linkShortener.connections, { id: 'c5', from: 'app', to: 'files' }],
    }
    let state = freshState()
    let last = step(withBucket, state, 0, { shape: 'steady' })
    for (let i = 0; i < 50; i++) { last = step(withBucket, state, 0.1, { shape: 'steady' }); state = last.state }
    const ts = Array.from({ length: 100 }, (_, i) => sampleTrace(withBucket, last.result, 40 + i, undefined, undefined, 'upload')!)
    expect(ts.every((t) => t.hops[t.hops.length - 1].nodeId === 'files' || t.outcome !== 'ok')).toBe(true)
    expect(ts.some((t) => t.hops.some((h) => h.nodeId === 'files'))).toBe(true)
  })
  it('during a failover writes fail but reads still get through', () => {
    const replicated: Architecture = {
      ...linkShortener,
      components: linkShortener.components.map((c) => (c.id === 'db' ? { ...c, config: { ...c.config, replicas: 2, failoverSec: 30 } } : c)),
    }
    let state = freshState()
    let last = step(replicated, state, 0, { shape: 'steady', injected: { db: 'killed' } })
    for (let i = 0; i < 30; i++) { last = step(replicated, state, 0.1, { shape: 'steady', injected: { db: 'killed' } }); state = last.state }
    expect(last.result.nodes.db.failover?.phase).toBe('failing')
    const run = (type: 'read' | 'write') => Array.from({ length: 300 }, (_, i) => sampleTrace(replicated, last.result, 70 + i, undefined, undefined, type)!)
    const writes = run('write')
    expect(writes.every((t) => t.outcome === 'dropped')).toBe(true)
    expect(writes[0].summary).toContain('writes fail')
    expect(run('read').filter((t) => t.outcome === 'ok').length).toBeGreaterThan(0)
  })
  it('a typical request keeps the original behaviour', () => {
    expect(sampleTrace(linkShortener, calm, 42)!.type).toBe('any')
    expect(sampleTrace(linkShortener, calm, 42)).toEqual(sampleTrace(linkShortener, calm, 42, undefined, undefined, 'any'))
  })
  it('summarises a type', () => {
    expect(sampleTraces(linkShortener, calm, 3, 50, undefined, 'write')!.type).toBe('write')
  })
})

describe('traces match the aggregate cache behaviour', () => {
  it('a typical request is answered by the cache at the share the simulation reports, even for a write-heavy client', () => {
    const arch: Architecture = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'client' ? { ...c, config: { ...c.config, readPct: 0.5 } } : c)) }
    let state = freshState()
    let last = step(arch, state, 0, { shape: 'steady' })
    for (let i = 0; i < 50; i++) { last = step(arch, state, 0.1, { shape: 'steady' }); state = last.state }
    const hops = Array.from({ length: 1500 }, (_, i) => sampleTrace(arch, last.result, 300 + i)!).flatMap((t) => t.hops.filter((h) => h.kind === 'cache'))
    const rate = hops.filter((h) => h.outcome === 'hit').length / hops.length
    expect(rate).toBeCloseTo(last.result.nodes.cache.hit, 1)
  })
})
