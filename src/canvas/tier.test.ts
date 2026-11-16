import { describe, expect, it } from 'vitest'
import { balancerLevel, cacheLevel, clientMonitors, cpuLevel, levelOf, lookKey, MAX_LEVEL, queueCrates } from './tier'
import { PRESETS } from '../presets/index'
import type { ArchComponent } from '../store/types'

const comp = (kind: ArchComponent['kind'], config: Record<string, number>): ArchComponent => ({ id: 'x', kind, name: 'x', position: { col: 0, row: 0 }, config })

describe('upgrade levels', () => {
  it('vCPUs map to levels 1 to 6 and never beyond', () => {
    expect([1, 2, 4, 8, 16, 32, 64].map(cpuLevel)).toEqual([1, 2, 3, 4, 5, 6, 6])
  })
  it('every step up in vCPUs is a visible step up for servers and databases', () => {
    for (const kind of ['appServers', 'database'] as const) {
      const levels = [1, 2, 4, 8, 16, 32].map((v) => levelOf(comp(kind, { vcpu: v })))
      expect(levels).toEqual([1, 2, 3, 4, 5, 6])
    }
  })
  it('bigger caches grow more shelves', () => {
    expect([0.5, 0.6, 0.65, 0.8, 0.95, 0.98].map(cacheLevel)).toEqual([1, 1, 2, 3, 4, 4])
  })
  it('more balancer targets means more slabs', () => {
    expect([1, 2, 3, 4, 5, 8].map(balancerLevel)).toEqual([1, 1, 2, 2, 3, 3])
  })
  it('faster queues get more crates, within limits', () => {
    expect([50, 100, 400, 2000].map(queueCrates)).toEqual([2, 2, 4, 6])
  })
  it('busier clients get more monitors', () => {
    expect([50, 400, 1000, 3000].map(clientMonitors)).toEqual([1, 2, 3, 4])
  })
  it('levels are always in range, for every component of every starter', () => {
    for (const p of PRESETS) for (const c of p.arch.components) {
      const l = levelOf(c)
      expect(l).toBeGreaterThanOrEqual(1)
      expect(l).toBeLessThanOrEqual(MAX_LEVEL)
    }
  })
  it('the look key changes exactly when the look would', () => {
    const a = comp('appServers', { vcpu: 4, ramGb: 8, instances: 2 })
    expect(lookKey(a)).toBe(lookKey(comp('appServers', { vcpu: 4, ramGb: 8, instances: 9 }))) // instance count does not change the look
    expect(lookKey(a)).not.toBe(lookKey(comp('appServers', { vcpu: 8, ramGb: 8 })))
    expect(lookKey(a)).toBe(lookKey(comp('appServers', { vcpu: 4, ramGb: 32 }))) // memory does not change the look
    expect(lookKey(a)).not.toBe(lookKey(comp('appServers', { vcpu: 4, ramGb: 8, autoscale: 1 })))
  })
})
