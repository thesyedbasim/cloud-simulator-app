import { describe, expect, it } from 'vitest'
import { freshState, step } from './engine'
import type { Architecture } from '../store/types'

const arch = (mix?: Record<string, number>, apps = true): Architecture => ({
  name: 'apps',
  components: [
    { id: 'c', kind: 'client', name: 'C', position: { col: 0, row: 0 }, config: { rps: 100, retries: 0 }, ...(mix ? { mix } : {}) },
    { id: 'app', kind: 'appServers', name: 'App', position: { col: 4, row: 0 }, config: { instances: 8, vcpu: 8, ramGb: 16 },
      ...(apps ? { apps: [{ id: 'a1', name: 'A1', targets: ['bk'] }, { id: 'a2', name: 'A2', targets: ['bk', 'db'] }, { id: 'a3', name: 'A3', targets: ['db'] }] } : {}) },
    { id: 'bk', kind: 'bucket', name: 'Bucket', position: { col: 8, row: 0 }, config: {} },
    { id: 'db', kind: 'database', name: 'DB', position: { col: 8, row: 4 }, config: { vcpu: 8, ramGb: 32, poolSize: 100 } },
  ],
  connections: [{ id: 'e0', from: 'c', to: 'app' }, { id: 'e1', from: 'app', to: 'bk' }, { id: 'e2', from: 'app', to: 'db' }],
})
const run = (a: Architecture) => { let s = freshState(); let r = step(a, s, 0, { shape: 'steady' }).result; for (let i = 0; i < 30; i++) { const o = step(a, s, 0.1, { shape: 'steady' }); s = o.state; r = o.result } return r }

describe('applications', () => {
  it('route each application to the targets it lists, by the client mix', () => {
    const r = run(arch({ a1: 30, a2: 40, a3: 30 }))
    expect(r.edges.e1.rps).toBeCloseTo(70, 0) // a1 + a2
    expect(r.edges.e2.rps).toBeCloseTo(70, 0) // a2 + a3
  })
  it('split evenly across applications when the client has no mix', () => {
    const r = run(arch())
    expect(r.edges.e1.rps).toBeCloseTo(66.7, 0)
  })
  it('a request calling two targets is counted as one completed request', () => {
    const r = run(arch({ a2: 100 }))
    expect(r.totals.throughput).toBeCloseTo(100, 0)
    expect(r.edges.e1.rps).toBeCloseTo(100, 0)
  })
  it('without applications nothing changes: an even split between connections', () => {
    const r = run(arch(undefined, false))
    expect(r.edges.e1.rps).toBeCloseTo(50, 0)
  })
  it('read share, size and cost come from the applications, not the client', () => {
    const a = arch({ a1: 100 })
    const withApp = (read: number): Architecture => ({ ...a, components: a.components.map((c) => (c.id === 'app' ? { ...c, apps: [{ id: 'a1', name: 'A1', targets: ['db'], readPct: read }] } : c)) })
    const reads = run(withApp(1)).nodes.db, writes = run(withApp(0)).nodes.db
    expect(writes.util).toBeGreaterThan(reads.util) // writes cost the database more
  })
})

import { MAX_TRIGGER_RPS } from './triggers'
import { analyze } from './insight'
describe('triggers', () => {
  const base = (triggers: unknown[], guard = 0, ratio = 1): Architecture => ({
    name: 'trig',
    components: [
      { id: 'c', kind: 'client', name: 'C', position: { col: 0, row: 0 }, config: { rps: 50, retries: 0 } },
      { id: 'db', kind: 'database', name: 'DB', position: { col: 8, row: 0 }, config: { vcpu: 8, ramGb: 32, poolSize: 200 } },
      { id: 'fn', kind: 'serverless', name: 'Fn', position: { col: 4, row: 4 }, config: { memoryMb: 512, concurrency: 1000, recursionGuard: guard }, triggers: (triggers as never[]).map((t) => ({ ...(t as object), ratio })) as never },
    ],
    connections: [{ id: 'e0', from: 'c', to: 'db' }, { id: 'e1', from: 'fn', to: 'db' }],
  })
  const evt = [{ id: 't', kind: 'event', source: 'db', readPct: 0 }]
  const go = (a: Architecture, secs = 6) => { let s = freshState(); let r = step(a, s, 0, { shape: 'steady' }).result; for (let i = 0; i < secs * 10; i++) { const o = step(a, s, 0.1, { shape: 'steady' }); s = o.state; r = o.result } return r }
  it('a schedule runs the function at batch / interval', () => {
    const r = go(base([{ id: 't', kind: 'schedule', everySec: 10, batch: 50 }]))
    expect(r.nodes.fn.offered).toBeCloseTo(5, 1)
  })
  it('an event trigger follows the source writes', () => {
    const r = go(base(evt, 0, 0.2))
    expect(r.nodes.fn.trigger!.loop).toBe(true)
    expect(r.nodes.fn.offered).toBeCloseTo(1.25, 1) // 5 writes/s x 0.2 = 1, plus the loop: 1 / (1 - 0.2)
  })
  it('a loop with gain above 1 runs away, and the guard stops it', () => {
    const wild = go(base(evt, 0, 1.5), 8)
    expect(wild.nodes.fn.trigger!.rps).toBeGreaterThan(100)
    expect(analyze(base(evt, 0, 1.5), wild)?.key).toBe('fn:loop')
    const guarded = go(base(evt, 1, 1.5), 8)
    expect(guarded.nodes.fn.trigger!.rps).toBeLessThan(MAX_TRIGGER_RPS / 100)
    expect(guarded.nodes.fn.trigger!.rps).toBeLessThan(60)
  })
})

import { sampleTrace } from './trace'
describe('traces follow applications', () => {
  const a = arch({ a1: 30, a2: 40, a3: 30 })
  const res = run(a)
  const names = (id: string) => sampleTrace(a, res, 7, undefined, undefined, 'any', id)!.hops.map((h) => h.nodeId)
  it('an application visits only the targets it lists, in order', () => {
    expect(names('a1')).toEqual(['c', 'app', 'bk'])
    expect(names('a3')).toEqual(['c', 'app', 'db'])
    const both = names('a2')
    expect(both).toEqual(['c', 'app', 'bk', 'app', 'db'])
    const t = sampleTrace(a, res, 7, undefined, undefined, 'any', 'a2')!
    expect(t.edges.length).toBe(t.hops.length - 1)
  })
  it('the request is a read or a write by the application', () => {
    const w = { ...a, components: a.components.map((c) => (c.id === 'app' ? { ...c, apps: c.apps!.map((x) => (x.id === 'a3' ? { ...x, readPct: 0 } : x)) } : c)) }
    expect(sampleTrace(w, run(w), 3, undefined, undefined, 'any', 'a3')!.type).toBe('write')
  })
})

import { DEFAULT_PROFILE, functionDurationMs, runOn } from './capacity'
describe('function run profile', () => {
  it('the default run takes 100 ms at 512 MB and does not fail', () => {
    expect(functionDurationMs({ memoryMb: 512 })).toBeCloseTo(100, 5)
    expect(runOn(DEFAULT_PROFILE, 512).oom).toBe(false)
  })
  it('fails for lack of memory, slows for lack of CPU, and extra memory does not speed it up', () => {
    expect(runOn({ runMs: 100, memoryMb: 1024, cores: 0.1 }, 512).oom).toBe(true)
    const slow = runOn({ runMs: 100, memoryMb: 128, cores: 1 }, 512) // 512 MB is 0.29 vCPU
    expect(slow.slowdown).toBeCloseTo(1769 / 512, 3)
    expect(runOn({ runMs: 100, memoryMb: 128, cores: 0.25 }, 3008).ms).toBe(100)
  })
  it('an application that needs more memory than the function has fails in the simulation', () => {
    const base = arch()
    const a: Architecture = { ...base, components: [...base.components.filter((c) => c.id !== 'app'), { id: 'fn', kind: 'serverless', name: 'Fn', position: { col: 4, row: 0 }, config: { memoryMb: 512, concurrency: 1000 }, apps: [{ id: 'big', name: 'Big', targets: ['db'], memoryMb: 1024, runMs: 100, cores: 0.2 }] }], connections: [{ id: 'e0', from: 'c', to: 'fn' }, { id: 'e2', from: 'fn', to: 'db' }] }
    const r = run(a)
    expect(r.nodes.fn.fn!.oom).toBe(1)
    expect(r.nodes.fn.served).toBeCloseTo(0, 3)
    expect(analyze(a, r)?.key).toBe('fn:oom')
  })
})
