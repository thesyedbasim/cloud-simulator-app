import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { PRESETS } from '../presets/index'
import { parseProject, serializeProject } from './project'

const ok = (t: string) => { const r = parseProject(t); if (!r.ok) throw new Error(r.error); return r }
const bad = (t: string) => { const r = parseProject(t); if (r.ok) throw new Error('expected failure'); return r.error }
const wrap = (architecture: unknown, extra: object = {}) => JSON.stringify({ app: 'cloudsim', version: 1, architecture, ...extra })

describe('project files', () => {
  it('round-trips every preset exactly', () => {
    for (const p of PRESETS) expect(ok(serializeProject(p.arch)).arch).toEqual(p.arch)
  })
  it('round-trips a design with a modified setting', () => {
    const arch = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 7 } } : c)) }
    expect(ok(serializeProject(arch)).arch.components.find((c) => c.id === 'app')!.config.instances).toBe(7)
  })
  it('rejects files that are not ours', () => {
    expect(bad('not json')).toMatch(/valid JSON/)
    expect(bad('{"hello":1}')).toMatch(/CloudSim project/)
    expect(bad(JSON.stringify({ app: 'cloudsim', version: 99, architecture: {} }))).toMatch(/newer version/)
    expect(bad(wrap({ components: 'x', connections: [] }))).toMatch(/no architecture/)
  })
  it('clamps out-of-range settings and fills in missing ones', () => {
    const arch = { name: 'x', components: [{ id: 'a', kind: 'appServers', name: 'A', position: { col: 0, row: 0 }, config: { instances: 9999, vcpu: -5 } }], connections: [] }
    const c = ok(wrap(arch)).arch.components[0]
    expect(c.config.instances).toBe(20)
    expect(c.config.vcpu).toBe(1)
    expect(c.config.ramGb).toBe(8)
  })
  it('drops unknown config keys and unknown kinds, with warnings', () => {
    const arch = { name: 'x', components: [
      { id: 'a', kind: 'cache', name: 'C', position: { col: 0, row: 0 }, config: { hitRate: 0.5, evil: 1 } },
      { id: 'b', kind: 'teleporter', name: 'T', position: { col: 5, row: 0 }, config: {} },
    ], connections: [] }
    const r = ok(wrap(arch))
    expect(Object.keys(r.arch.components[0].config)).toEqual(['hitRate'])
    expect(r.arch.components).toHaveLength(1)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('drops connections to missing components, self-links and duplicates', () => {
    const comps = [
      { id: 'a', kind: 'client', name: 'A', position: { col: 0, row: 0 }, config: { rps: 100 } },
      { id: 'b', kind: 'loadBalancer', name: 'B', position: { col: 4, row: 0 }, config: { targets: 2 } },
    ]
    const conns = [{ id: '1', from: 'a', to: 'b' }, { id: '2', from: 'a', to: 'zzz' }, { id: '3', from: 'a', to: 'a' }, { id: '4', from: 'a', to: 'b' }, { id: '5', from: 'b', to: 'a' }]
    expect(ok(wrap({ name: 'x', components: comps, connections: conns })).arch.connections).toEqual([{ id: '1', from: 'a', to: 'b' }])
  })
  it('refuses overlapping components and off-canvas positions', () => {
    const mk = (b: object) => wrap({ name: 'x', components: [
      { id: 'a', kind: 'client', name: 'A', position: { col: 0, row: 0 }, config: {} },
      { id: 'b', kind: 'client', name: 'B', ...b, config: {} },
    ], connections: [] })
    expect(bad(mk({ position: { col: 1, row: 1 } }))).toMatch(/overlap/)
    const r = ok(mk({ position: { col: 500, row: 0 } }))
    expect(r.arch.components).toHaveLength(1)
  })
  it('caps the size of a project', () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, kind: 'client', name: 'x', position: { col: i, row: 0 }, config: {} }))
    expect(bad(wrap({ name: 'x', components: many, connections: [] }))).toMatch(/Too many components/)
  })

  it('keeps optional autoscaling settings, clamps them, and leaves them absent when the file has none', () => {
    const mk = (config: object) => wrap({ name: 'x', components: [{ id: 'a', kind: 'appServers', name: 'A', position: { col: 0, row: 0 }, config }], connections: [] })
    const withAuto = ok(mk({ instances: 2, vcpu: 4, ramGb: 8, autoscale: 1, maxInstances: 999, warmupSec: 1, scaleUpAt: 0.7 })).arch.components[0].config
    expect(withAuto).toMatchObject({ autoscale: 1, maxInstances: 20, warmupSec: 5, scaleUpAt: 0.7 })
    const without = ok(mk({ instances: 2, vcpu: 4, ramGb: 8 })).arch.components[0].config
    expect('autoscale' in without).toBe(false)
  })

  it('keeps service-level targets, clamps them, and leaves them out when absent', () => {
    const base = { name: 'x', components: [], connections: [] }
    expect(ok(wrap({ ...base, slo: { availability: 0.999, p99Ms: 200 } })).arch.slo).toEqual({ availability: 0.999, p99Ms: 200 })
    expect(ok(wrap({ ...base, slo: { availability: 5, p99Ms: 1 } })).arch.slo).toEqual({ availability: 0.99999, p99Ms: 20 })
    expect(ok(wrap({ ...base, slo: { availability: 'lots' } })).arch.slo).toBeUndefined()
    expect(ok(wrap(base)).arch.slo).toBeUndefined()
  })
})
