import { describe, expect, it } from 'vitest'
import { freshState, step } from './engine'
import { hourlyCost, specLine } from './capacity'
import { sampleTrace } from './trace'
import { parseProject, serializeProject } from '../store/project'
import { GEO_BLOCK } from './geo'
import { DEFAULT_CONFIG } from '../store/types'
import type { Architecture, ArchComponent, ComponentKind } from '../store/types'

const comp = (id: string, kind: ComponentKind, config: Record<string, number> = {}, i = 0): ArchComponent => ({ id, kind, name: id, position: { col: i * 3, row: 0 }, config: { ...DEFAULT_CONFIG[kind], ...config } })
const chain = (kinds: [string, ComponentKind, Record<string, number>?][]): Architecture => ({
  name: 't',
  components: kinds.map(([id, k, cfg], i) => comp(id, k, cfg, i)),
  connections: kinds.slice(1).map(([id], i) => ({ id: `e${i}`, from: kinds[i][0], to: id })),
})
function run(arch: Architecture, seconds = 5) {
  let state = freshState()
  let last = step(arch, state, 0, { shape: 'steady' })
  for (let i = 0; i < seconds * 10; i++) { last = step(arch, state, 0.1, { shape: 'steady' }); state = last.state }
  return last.result
}

describe('CDN', () => {
  it('answers hits itself and shields the origin', () => {
    const r = run(chain([['c', 'client', { rps: 1000 }], ['cdn', 'cdn', { hitRate: 0.9 }], ['app', 'appServers']]))
    expect(r.nodes.cdn.hit).toBeCloseTo(0.9)
    expect(r.nodes.app.offered).toBeCloseTo(100, 0)
    expect(r.totals.throughput).toBeCloseTo(1000, 0)
  })

  it('a trace can be served by the CDN without reaching the origin', () => {
    const arch = chain([['c', 'client', { rps: 1000 }], ['cdn', 'cdn', { hitRate: 0.99 }], ['app', 'appServers']])
    const t = sampleTrace(arch, run(arch), 3)!
    expect(t.hops.some((h) => h.nodeId === 'app')).toBe(false)
    expect(t.hops[t.hops.length - 1].note).toContain('CDN')
  })
})

describe('storage bucket', () => {
  it('serves requests up to its prefix limit, then throttles', () => {
    const under = run(chain([['c', 'client', { rps: 4000 }], ['b', 'bucket', { prefixes: 1 }]]))
    expect(under.nodes.b.dropped).toBe(0)
    const over = run(chain([['c', 'client', { rps: 8000 }], ['b', 'bucket', { prefixes: 1 }]]))
    expect(over.nodes.b.health).toBe('failed')
    expect(over.nodes.b.dropped).toBeGreaterThan(1000)
    const spread = run(chain([['c', 'client', { rps: 8000 }], ['b', 'bucket', { prefixes: 2 }]]))
    expect(spread.nodes.b.dropped).toBe(0)
  })

  it('costs more with more stored data', () => {
    expect(hourlyCost('bucket', { storageGb: 4000 })).toBeGreaterThan(hourlyCost('bucket', { storageGb: 100 }))
  })
})

describe('API gateway', () => {
  it('passes traffic through under its limit', () => {
    const r = run(chain([['c', 'client', { rps: 1000 }], ['gw', 'gateway', { rateLimit: 2000 }], ['app', 'appServers', { instances: 4 }]]))
    expect(r.nodes.gw.dropped).toBe(0)
    expect(r.nodes.app.offered).toBeCloseTo(1000, 0)
  })

  it('rate limits the excess and protects what is behind it, without looking broken', () => {
    const arch = chain([['c', 'client', { rps: 3000 }], ['gw', 'gateway', { rateLimit: 1000 }], ['app', 'appServers', { instances: 4 }]])
    const r = run(arch, 2)
    expect(r.nodes.gw.dropped).toBeGreaterThan(1000)
    expect(r.nodes.gw.health).toBe('strained')
    expect(r.nodes.app.health).toBe('healthy')
    expect(r.nodes.app.offered).toBeLessThanOrEqual(1000.01)
    const t = sampleTrace(arch, r, 5)
    expect(t).not.toBeNull()
  })

  it('with the limit off everything gets through', () => {
    const r = run(chain([['c', 'client', { rps: 3000 }], ['gw', 'gateway', { rateLimit: 1000, limitOn: 0 }], ['app', 'appServers', { instances: 8 }]]))
    expect(r.nodes.gw.dropped).toBe(0)
  })

  it('a killed gateway really is down', () => {
    let state = freshState()
    const arch = chain([['c', 'client', { rps: 500 }], ['gw', 'gateway'], ['app', 'appServers']])
    let last = step(arch, state, 0, { shape: 'steady', injected: { gw: 'killed' } })
    for (let i = 0; i < 20; i++) { last = step(arch, state, 0.1, { shape: 'steady', injected: { gw: 'killed' } }); state = last.state }
    expect(last.result.nodes.gw.health).toBe('failed')
  })

  it('applies a geo rule cheaply at the edge', () => {
    const arch: Architecture = chain([['c', 'client', { rps: 500, region: 2 }], ['gw', 'gateway', { geoMode: GEO_BLOCK, geoMask: 1 << 2 }], ['app', 'appServers']])
    const r = run(arch)
    expect(r.nodes.gw.blocked).toBeCloseTo(500, 0)
    expect(r.totals.errorRate).toBeLessThan(0.001)
    expect(r.nodes.app.offered).toBe(0)
  })
})

describe('new kinds in general', () => {
  it('every kind has a cost, a spec line and survives saving', () => {
    const kinds: ComponentKind[] = ['gateway', 'cdn', 'bucket']
    const arch: Architecture = { name: 't', components: kinds.map((k, i) => comp(k, k, {}, i)), connections: [] }
    for (const k of kinds) { expect(hourlyCost(k, DEFAULT_CONFIG[k])).toBeGreaterThan(0); expect(specLine(k, DEFAULT_CONFIG[k])).not.toBe('') }
    const r = parseProject(serializeProject(arch))
    expect(r.ok && r.arch.components.map((c) => c.kind)).toEqual(kinds)
  })
})

describe('serverless function', () => {
  const fn = (rps: number, cfg: Record<string, number> = {}) => chain([['c', 'client', { rps }], ['f', 'serverless', cfg], ['db', 'database', { vcpu: 64, ramGb: 256, poolSize: 200, pooler: 1 }]])
  function ramp(arch: Architecture, shape: 'steady' | 'flash', seconds: number) {
    let state = freshState()
    let last = step(arch, state, 0, { shape })
    let peakCold = 0
    let peakP99 = 0
    for (let i = 0; i < seconds * 10; i++) { last = step(arch, state, 0.1, { shape }); state = last.state; peakCold = Math.max(peakCold, last.result.nodes.f.cold ?? 0); peakP99 = Math.max(peakP99, last.result.totals.p99) }
    return { r: last.result, peakCold, peakP99 }
  }

  it('handles traffic with no instances to manage, and passes it on', () => {
    const { r } = ramp(fn(800), 'steady', 5)
    expect(r.nodes.f.dropped).toBe(0)
    expect(r.nodes.db.offered).toBeCloseTo(800, 0)
    expect(r.nodes.f.latency).toBeCloseTo(100, 0) // 512 MB runs in about 100 ms, with no queueing
  })

  it('more memory means faster calls', () => {
    expect(ramp(fn(500, { memoryMb: 2048 }), 'steady', 3).r.nodes.f.latency).toBeLessThan(ramp(fn(500, { memoryMb: 256 }), 'steady', 3).r.nodes.f.latency)
  })

  it('throttles at the concurrency limit, and a bigger limit fixes it', () => {
    const low = ramp(fn(3000, { concurrency: 100 }), 'steady', 3).r
    expect(low.nodes.f.health).toBe('failed')
    expect(low.nodes.f.dropped).toBeGreaterThan(1500)
    expect(ramp(fn(3000, { concurrency: 1000 }), 'steady', 3).r.nodes.f.dropped).toBe(0)
  })

  it('steady load has no cold starts; a sudden jump does, and always-warm instances prevent them', () => {
    expect(ramp(fn(500), 'steady', 5).peakCold).toBe(0)
    const flash = ramp(fn(500), 'flash', 20)
    expect(flash.peakCold).toBeGreaterThan(0.01)
    expect(flash.peakP99).toBeGreaterThan(400)
    expect(ramp(fn(500, { provisioned: 500 }), 'flash', 20).peakCold).toBe(0)
  })

  it('cost follows traffic, and idle always-warm instances cost money', () => {
    const busy = ramp(fn(2000), 'steady', 3).r.nodes.f
    const quiet = ramp(fn(100), 'steady', 3).r.nodes.f
    expect(busy.served).toBeGreaterThan(quiet.served)
    const cost = (rps: number, extra: Record<string, number> = {}) => hourlyCost('serverless', { ...DEFAULT_CONFIG.serverless, ...extra, rps })
    expect(cost(2000)).toBeGreaterThan(cost(100))
    expect(cost(0, { provisioned: 100 })).toBeGreaterThan(cost(0))
    expect(cost(0)).toBe(0) // scales to zero
  })

  it('survives saving', () => {
    const arch = fn(100, { memoryMb: 1024, provisioned: 20 })
    const r = parseProject(serializeProject(arch))
    expect(r.ok && r.arch.components[1].config).toMatchObject({ memoryMb: 1024, concurrency: 1000, provisioned: 20 })
  })
})

describe('database connections from functions, and read replicas', () => {
  const withDb = (rps: number, db: Record<string, number>, client: Record<string, number> = {}) =>
    chain([['c', 'client', { rps, ...client }], ['f', 'serverless'], ['db', 'database', { vcpu: 64, ramGb: 256, ...db }]])

  it('many function instances exhaust a small connection pool', () => {
    const r = run(withDb(1000, { poolSize: 20 })) // about 100 running at once, 20 connections
    expect(r.nodes.db.conns!.demand).toBeGreaterThan(80)
    expect(r.nodes.db.health).toBe('failed')
    expect(r.nodes.db.dropped).toBeGreaterThan(500)
    expect(r.nodes.db.poolUsed).toBe(20)
  })

  it('a connection pooler shares a few connections between them all', () => {
    const r = run(withDb(1000, { poolSize: 20, pooler: 1 }))
    expect(r.nodes.db.dropped).toBeLessThan(1)
    expect(r.nodes.db.conns!.pooled).toBe(true)
    expect(r.totals.errorRate).toBeLessThan(0.001)
  })

  it('a bigger pool also fixes it, and the pooler costs a little extra', () => {
    expect(run(withDb(1000, { poolSize: 200 })).nodes.db.dropped).toBe(0)
    expect(hourlyCost('database', { vcpu: 4, ramGb: 16, pooler: 1 })).toBeGreaterThan(hourlyCost('database', { vcpu: 4, ramGb: 16 }))
  })

  it('app servers are not affected by the function connection rule', () => {
    const arch = chain([['c', 'client', { rps: 250 }], ['app', 'appServers', { instances: 4 }], ['db', 'database', { poolSize: 20 }]])
    expect(run(arch).nodes.db.conns!.demand).toBe(0)
  })

  it('read replicas raise a read-heavy database\'s capacity', () => {
    const db = { vcpu: 4, ramGb: 16, poolSize: 200 }
    const arch = (replicas: number) => chain([['c', 'client', { rps: 500, readPct: 0.95 }], ['db', 'database', { ...db, replicas }]])
    const none = run(arch(0)).nodes.db, three = run(arch(3)).nodes.db
    expect(none.health).toBe('failed') // 300 rps capacity
    expect(three.util).toBeLessThan(none.util * 0.5)
    expect(three.dropped).toBeLessThan(none.dropped)
  })

  it('replicas do not help a write-heavy workload as much', () => {
    const db = { vcpu: 4, ramGb: 16, poolSize: 200 }
    const util = (readPct: number, replicas: number) => run(chain([['c', 'client', { rps: 200, readPct }], ['db', 'database', { ...db, replicas }]])).nodes.db.util
    const gainReads = util(0.95, 0) / util(0.95, 4)
    const gainWrites = util(0.2, 0) / util(0.2, 4)
    expect(gainReads).toBeGreaterThan(gainWrites * 1.5)
    expect(gainWrites).toBeGreaterThan(1) // still a little help
  })

  it('every replica is a full copy to pay for', () => {
    expect(hourlyCost('database', { vcpu: 4, ramGb: 16, replicas: 2 })).toBeCloseTo(hourlyCost('database', { vcpu: 4, ramGb: 16 }) * 3, 5)
  })

  it('defaults are unchanged without replicas or a pooler', () => {
    const r = run(chain([['c', 'client', { rps: 250 }], ['db', 'database']]))
    expect(r.nodes.db.util).toBeCloseTo(250 / 300, 2)
  })
})
