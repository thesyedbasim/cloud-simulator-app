import { describe, expect, it } from 'vitest'
import { freshState, step } from './engine'
import { sampleTrace } from './trace'
import { accumulate, zeroCounters, sloOf } from './slo'
import { diffArch } from './review'
import { parseProject, serializeProject } from '../store/project'
import { GEO_ALLOW, GEO_BLOCK, geoAllows } from './geo'
import type { Architecture, ArchComponent } from '../store/types'

const EU = 2, US = 0, APAC = 3
const mask = (...r: number[]) => r.reduce((a, i) => a | (1 << i), 0)

function design(opts: { lb?: Record<string, number>; app?: Record<string, number>; clients?: Record<string, number>[] } = {}): Architecture {
  const clients: ArchComponent[] = (opts.clients ?? [{ rps: 200, region: US }, { rps: 200, region: EU }]).map((config, i) => ({ id: `c${i}`, kind: 'client', name: `Client ${i}`, position: { col: 0, row: i * 3 }, config }))
  return {
    name: 't',
    components: [
      ...clients,
      { id: 'lb', kind: 'loadBalancer', name: 'LB', position: { col: 3, row: 3 }, config: { targets: 2, ...opts.lb } },
      { id: 'app', kind: 'appServers', name: 'App', position: { col: 6, row: 3 }, config: { instances: 4, vcpu: 4, ramGb: 8, ...opts.app } },
    ],
    connections: [...clients.map((c) => ({ id: `e-${c.id}`, from: c.id, to: 'lb' })), { id: 'e2', from: 'lb', to: 'app' }],
  }
}

function run(arch: Architecture, seconds = 10) {
  let state = freshState()
  let last = step(arch, state, 0, { shape: 'steady' })
  for (let i = 0; i < seconds * 10; i++) { last = step(arch, state, 0.1, { shape: 'steady' }); state = last.state }
  return last.result
}

describe('geo rules', () => {
  it('without a rule every region gets through', () => {
    const r = run(design())
    expect(r.totals.blocked).toBe(0)
    expect(r.nodes.app.offered).toBeCloseTo(400, 0)
  })

  it('a block list turns away only the listed region, and it is not an error', () => {
    const r = run(design({ lb: { geoMode: GEO_BLOCK, geoMask: mask(EU) } }))
    expect(r.nodes.lb.blocked).toBeCloseTo(200, 0)
    expect(r.nodes.app.offered).toBeCloseTo(200, 0)
    expect(r.totals.blocked).toBeCloseTo(200, 0)
    expect(r.totals.errorRate).toBeLessThan(0.001)
    expect(r.totals.throughput).toBeCloseTo(200, 0)
  })

  it('an allow list turns away every region not on it', () => {
    const r = run(design({ clients: [{ rps: 100, region: US }, { rps: 100, region: EU }, { rps: 100, region: APAC }], lb: { geoMode: GEO_ALLOW, geoMask: mask(US) } }))
    expect(r.nodes.lb.blocked).toBeCloseTo(200, 0)
    expect(r.nodes.app.offered).toBeCloseTo(100, 0)
    expect(r.totals.errorRate).toBeLessThan(0.001)
  })

  it('allow-only with nothing ticked blocks everything', () => {
    const r = run(design({ lb: { geoMode: GEO_ALLOW, geoMask: 0 } }))
    expect(r.totals.blocked).toBeCloseTo(400, 0)
    expect(r.nodes.app.offered).toBe(0)
  })

  it('blocking at the app tier still costs capacity, blocking at the LB does not', () => {
    const flood = [{ rps: 400, region: US }, { rps: 4000, region: EU }]
    const small = { instances: 1, vcpu: 4, ramGb: 8 } // 500 rps
    const atApp = run(design({ clients: flood, app: { ...small, geoMode: GEO_BLOCK, geoMask: mask(EU) } }))
    const atLb = run(design({ clients: flood, app: small, lb: { geoMode: GEO_BLOCK, geoMask: mask(EU) } }))
    expect(atLb.nodes.app.util).toBeLessThan(1)
    expect(atLb.totals.errorRate).toBeLessThan(0.01)
    expect(atApp.nodes.app.util).toBeGreaterThan(atLb.nodes.app.util) // rejecting 4000 rps still burns CPU
    expect(atApp.nodes.app.blocked).toBeCloseTo(4000, -1)
  })

  it('heavier requests use more capacity', () => {
    const base = run(design({ clients: [{ rps: 400, region: US }] }))
    const heavy = run(design({ clients: [{ rps: 400, region: US, weight: 3 }] }))
    expect(heavy.nodes.app.util).toBeCloseTo(base.nodes.app.util * 3, 1)
  })

  it('a blocked client does not retry, so its traffic is not inflated by other clients\' failures', () => {
    // the US client overloads the app tier; the EU client is blocked at the load balancer
    const arch = design({ clients: [{ rps: 3000, region: US }, { rps: 100, region: EU }], app: { instances: 1 }, lb: { geoMode: GEO_BLOCK, geoMask: mask(EU) } })
    const r = run(arch, 20)
    expect(r.totals.retryFactor).toBeGreaterThan(0.3)
    expect(r.nodes.c1.offered).toBeCloseTo(100, 0)
  })

  it('geoAllows follows the mode', () => {
    const lb = { kind: 'loadBalancer' as const, config: { geoMode: GEO_BLOCK, geoMask: mask(EU) } }
    expect(geoAllows(lb, EU)).toBe(false)
    expect(geoAllows(lb, US)).toBe(true)
    expect(geoAllows({ kind: 'client', config: {} }, EU)).toBe(true)
  })

  it('blocked requests do not count against the error budget', () => {
    const slo = sloOf(design())
    const c = accumulate(zeroCounters(), { offered: 1000, blocked: 400, errorRate: 0, p99: 10 }, 1, slo)
    expect(c.req).toBe(600)
  })

  it('a trace from a blocked region ends in a block, not a failure', () => {
    const arch = design({ clients: [{ rps: 200, region: EU }], lb: { geoMode: GEO_BLOCK, geoMask: mask(EU) } })
    const t = sampleTrace(arch, run(arch), 1)!
    expect(t.outcome).toBe('blocked')
    expect(t.failedAt).toBe('lb')
    const ok = sampleTrace(design({ clients: [{ rps: 200, region: US }], lb: { geoMode: GEO_BLOCK, geoMask: mask(EU) } }), run(design({ clients: [{ rps: 200, region: US }] })), 1)!
    expect(ok.outcome).toBe('ok')
  })

  it('region and rules survive saving and loading', () => {
    const arch = design({ lb: { geoMode: GEO_BLOCK, geoMask: mask(EU, APAC) }, clients: [{ rps: 100, region: APAC, payloadKb: 50, readPct: 0.5, weight: 2, clientType: 2 }] })
    const r = parseProject(serializeProject(arch))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.arch.components[0].config).toMatchObject({ region: APAC, payloadKb: 50, readPct: 0.5, weight: 2, clientType: 2 })
    expect(r.arch.components.find((c) => c.id === 'lb')!.config).toMatchObject({ geoMode: GEO_BLOCK, geoMask: mask(EU, APAC) })
  })

  it('the design review describes region and rule changes in words', () => {
    const a = design()
    const b = design({ lb: { geoMode: GEO_BLOCK, geoMask: mask(EU) }, clients: [{ rps: 200, region: APAC }, { rps: 200, region: EU }] })
    const text = diffArch(a, b).map((c) => c.text).join('\n')
    expect(text).toContain('region US-East → APAC')
    expect(text).toContain('blocks eu')
  })
})
