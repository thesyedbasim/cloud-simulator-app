import { describe, expect, it } from 'vitest'
import { freshState, step, type Injected, type SimState } from './engine'
import { parseProject, serializeProject } from '../store/project'
import { sampleTrace } from './trace'
import { diffArch } from './review'
import type { Architecture, ArchComponent, Connection } from '../store/types'

interface T { id: string; instances?: number; vcpu?: number; ramGb?: number; autoscale?: boolean; maxInstances?: number; conn?: Record<string, number> }

function design(targets: T[], lb: Record<string, number> = {}, clients: Record<string, number>[] = [{ rps: 600 }]): Architecture {
  const cs: ArchComponent[] = clients.map((config, i) => ({ id: `cl${i}`, kind: 'client', name: `Client ${i}`, position: { col: 0, row: i * 3 }, config }))
  const apps: ArchComponent[] = targets.map((t, i) => ({
    id: t.id, kind: 'appServers', name: t.id, position: { col: 6, row: i * 3 },
    config: { instances: t.instances ?? 2, vcpu: t.vcpu ?? 4, ramGb: t.ramGb ?? 8, ...(t.autoscale ? { autoscale: 1, maxInstances: t.maxInstances ?? 8, warmupSec: 10 } : {}) },
  }))
  const connections: Connection[] = [
    ...cs.map((c) => ({ id: `in-${c.id}`, from: c.id, to: 'lb' })),
    ...targets.map((t) => ({ id: `e-${t.id}`, from: 'lb', to: t.id, ...(t.conn ? { config: t.conn } : {}) })),
  ]
  return { name: 't', components: [...cs, { id: 'lb', kind: 'loadBalancer', name: 'LB', position: { col: 3, row: 3 }, config: { targets: targets.length, ...lb } }, ...apps], connections }
}

function run(arch: Architecture, seconds: number, injected?: Record<string, Injected>, from?: SimState) {
  let state = from ?? freshState()
  let last = step(arch, state, 0, { shape: 'steady', injected })
  for (let i = 0; i < seconds * 10; i++) { last = step(arch, state, 0.1, { shape: 'steady', injected }); state = last.state }
  return { r: last.result, state }
}
const share = (r: ReturnType<typeof run>['r'], id: string) => r.edges[`e-${id}`].lb!.share

describe('load balancer policies', () => {
  it('round-robin splits evenly, even when targets differ in size', () => {
    const { r } = run(design([{ id: 'a' }, { id: 'b', instances: 1 }]), 5)
    expect(share(r, 'a')).toBeCloseTo(0.5, 2)
    expect(r.nodes.b.util).toBeGreaterThan(r.nodes.a.util * 1.9) // the small one works twice as hard
  })

  it('weighted follows the connection weights', () => {
    const { r } = run(design([{ id: 'a', conn: { weight: 3 } }, { id: 'b', conn: { weight: 1 } }], { policy: 1 }), 5)
    expect(share(r, 'a')).toBeCloseTo(0.75, 2)
    expect(r.edges['e-a'].rps).toBeCloseTo(450, 0)
  })

  it('least-load follows capacity, so unequal targets run at the same load', () => {
    const { r } = run(design([{ id: 'a', instances: 3 }, { id: 'b', instances: 1 }], { policy: 2 }), 5)
    expect(share(r, 'a')).toBeCloseTo(0.75, 2)
    expect(r.nodes.a.util).toBeCloseTo(r.nodes.b.util, 2)
  })

  it('least-load notices a slow target immediately; round-robin does not', () => {
    const slow = { b: 'slow' as Injected }
    const rr = run(design([{ id: 'a' }, { id: 'b' }], {}, [{ rps: 700 }]), 5, slow).r
    const ll = run(design([{ id: 'a' }, { id: 'b' }], { policy: 2 }, [{ rps: 700 }]), 5, slow).r
    expect(rr.nodes.b.health).toBe('failed')
    expect(ll.nodes.b.util).toBeLessThan(1)
    expect(ll.totals.errorRate).toBeLessThan(rr.totals.errorRate)
  })

  it('least-load follows an autoscaling group as it grows; static weights do not', () => {
    const groups: T[] = [{ id: 'a', instances: 1, autoscale: true, maxInstances: 6 }, { id: 'b', instances: 2 }]
    const arch = design(groups, { policy: 2 }, [{ rps: 1400 }])
    const early = run(arch, 1).r
    const late = run(arch, 40).r
    expect(share(late, 'a')).toBeGreaterThan(share(early, 'a') + 0.1)
  })

  it('IP hash with few addresses (bots) is lopsided; many addresses are close to even', () => {
    const humans = run(design([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { policy: 3 }, [{ rps: 600, clientType: 0 }]), 3).r
    const bots = run(design([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { policy: 3 }, [{ rps: 600, clientType: 2 }]), 3).r
    const spread = (r: typeof humans) => Math.max(...['a', 'b', 'c'].map((i) => share(r, i))) - Math.min(...['a', 'b', 'c'].map((i) => share(r, i)))
    expect(spread(humans)).toBeLessThan(0.3)
    expect(spread(bots)).toBeGreaterThanOrEqual(0.5) // two addresses cannot reach three targets
  })

  it('hash is sticky: removing one target only moves that target\'s clients', () => {
    const arch = design([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { policy: 3 }, [{ rps: 600 }])
    const before = run(arch, 3).r
    const drained = design([{ id: 'a' }, { id: 'b' }, { id: 'c', conn: { drain: 1 } }], { policy: 3 }, [{ rps: 600 }])
    const after = run(drained, 3).r
    expect(share(after, 'c')).toBe(0)
    expect(share(after, 'a')).toBeGreaterThanOrEqual(share(before, 'a'))
    expect(share(after, 'b')).toBeGreaterThanOrEqual(share(before, 'b'))
  })
})

describe('health checks', () => {
  it('a killed target keeps getting traffic until the checks notice, then is taken out', () => {
    const arch = design([{ id: 'a' }, { id: 'b' }], { hcInterval: 2, hcFails: 3 })
    let { r, state } = run(arch, 3, { b: 'killed' })
    expect(share(r, 'b')).toBeCloseTo(0.5, 2) // not noticed yet
    expect(r.totals.errorRate).toBeGreaterThan(0.3)
    ;({ r, state } = run(arch, 5, { b: 'killed' }, state))
    expect(r.edges['e-b'].lb!.status).toBe('unhealthy')
    expect(share(r, 'b')).toBe(0)
    expect(r.totals.errorRate).toBeLessThan(0.01)
  })

  it('detection time follows the interval and the failure count', () => {
    const slowChecks = design([{ id: 'a' }, { id: 'b' }], { hcInterval: 10, hcFails: 3 })
    const { r } = run(slowChecks, 15, { b: 'killed' })
    expect(r.edges['e-b'].lb!.status).not.toBe('unhealthy') // 3 failures at 10 s need about 30 s
  })

  it('with checks off a dead target is never removed', () => {
    const { r } = run(design([{ id: 'a' }, { id: 'b' }], { healthCheck: 0 }), 30, { b: 'killed' })
    expect(share(r, 'b')).toBeCloseTo(0.5, 2)
  })

  it('the target is put back after it recovers', () => {
    const arch = design([{ id: 'a' }, { id: 'b' }], { hcInterval: 1, hcFails: 2 })
    let { r, state } = run(arch, 6, { b: 'killed' })
    expect(share(r, 'b')).toBe(0)
    ;({ r } = run(arch, 6, undefined, state))
    expect(share(r, 'b')).toBeGreaterThan(0.4)
  })

  it('if every target is out the balancer keeps trying them all', () => {
    const { r } = run(design([{ id: 'a' }, { id: 'b' }], { hcInterval: 1, hcFails: 2 }), 10, { a: 'killed', b: 'killed' })
    expect(share(r, 'a') + share(r, 'b')).toBeCloseTo(1, 5)
  })
})

describe('backup, drain and slow start', () => {
  it('a backup gets nothing until every primary is out', () => {
    const arch = design([{ id: 'a' }, { id: 'spare', conn: { backup: 1 } }], { hcInterval: 1, hcFails: 2 })
    let { r, state } = run(arch, 5)
    expect(share(r, 'spare')).toBe(0)
    expect(r.edges['e-spare'].lb!.status).toBe('standby')
    ;({ r } = run(arch, 6, { a: 'killed' }, state))
    expect(share(r, 'spare')).toBe(1)
    expect(r.totals.errorRate).toBeLessThan(0.01)
  })

  it('draining eases traffic off over the drain time, then stops it', () => {
    const lb = { drainSec: 10 }
    const before = design([{ id: 'a' }, { id: 'b' }], lb)
    let { r, state } = run(before, 3)
    const draining = design([{ id: 'a' }, { id: 'b', conn: { drain: 1 } }], lb)
    ;({ r, state } = run(draining, 5, undefined, state))
    expect(share(r, 'b')).toBeGreaterThan(0.05)
    expect(share(r, 'b')).toBeLessThan(0.45)
    expect(r.edges['e-b'].lb!.status).toBe('draining')
    ;({ r } = run(draining, 8, undefined, state))
    expect(share(r, 'b')).toBe(0)
    expect(r.edges['e-b'].lb!.status).toBe('drained')
  })

  it('slow start ramps a recovered target back in', () => {
    const arch = design([{ id: 'a' }, { id: 'b' }], { hcInterval: 1, hcFails: 2, slowStartSec: 20 })
    let { state } = run(arch, 6, { b: 'killed' })
    let { r } = run(arch, 4, undefined, state) // just recovered
    expect(r.edges['e-b'].lb!.status).toBe('warming')
    const early = share(r, 'b')
    ;({ r } = run(arch, 30, undefined, state))
    expect(share(r, 'b')).toBeGreaterThan(early)
    expect(share(r, 'b')).toBeCloseTo(0.5, 1)
  })

  it('traffic is conserved through the balancer', () => {
    for (const policy of [0, 1, 2, 3]) {
      const { r } = run(design([{ id: 'a', conn: { weight: 2 } }, { id: 'b', instances: 3 }, { id: 'c', conn: { backup: 1 } }], { policy }), 4)
      expect(r.edges['e-a'].rps + r.edges['e-b'].rps + r.edges['e-c'].rps).toBeCloseTo(r.nodes.lb.served, 3)
    }
  })
})

describe('saving and reviewing', () => {
  it('connection settings and balancer settings survive saving', () => {
    const arch = design([{ id: 'a', conn: { weight: 4, backup: 1 } }, { id: 'b' }], { policy: 1, hcInterval: 9, slowStartSec: 30 })
    const r = parseProject(serializeProject(arch))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.arch.connections.find((c) => c.id === 'e-a')!.config).toEqual({ weight: 4, backup: 1 })
    expect(r.arch.connections.find((c) => c.id === 'e-b')!.config).toBeUndefined()
    expect(r.arch.components.find((c) => c.id === 'lb')!.config).toMatchObject({ policy: 1, hcInterval: 9, slowStartSec: 30 })
  })

  it('out-of-range connection settings are clamped on load', () => {
    const arch = design([{ id: 'a', conn: { weight: 99 } }, { id: 'b' }])
    const r = parseProject(serializeProject(arch))
    expect(r.ok && r.arch.connections.find((c) => c.id === 'e-a')!.config!.weight).toBe(10)
  })

  it('a trace follows where the traffic really goes', () => {
    const arch = design([{ id: 'a', conn: { weight: 1 } }, { id: 'b', conn: { weight: 9 } }], { policy: 1 })
    const { r } = run(arch, 3)
    let toB = 0
    for (let i = 1; i <= 200; i++) { const t = sampleTrace(arch, r, i); if (t?.hops.some((h) => h.nodeId === 'b')) toB++ }
    expect(toB).toBeGreaterThan(150)
  })

  it('the design review notices a changed policy', () => {
    const a = design([{ id: 'a' }, { id: 'b' }])
    const b = design([{ id: 'a' }, { id: 'b' }], { policy: 2 })
    expect(diffArch(a, b).some((c) => /balancing/i.test(c.text))).toBe(true)
  })
})
