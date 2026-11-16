import { describe, expect, it } from 'vitest'
import { appCapacityPerInstance, dbCapacity, hourlyCost, scaleSpec } from './capacity'

describe('capacity', () => {
  it('app capacity is the lower of the CPU and RAM limits', () => {
    expect(appCapacityPerInstance({ vcpu: 4, ramGb: 8 })).toEqual({ rps: 500, limiter: 'CPU' })
    expect(appCapacityPerInstance({ vcpu: 8, ramGb: 2 })).toEqual({ rps: 200, limiter: 'RAM' })
  })
  it('adding vCPUs does nothing once RAM is the bottleneck', () => {
    const a = appCapacityPerInstance({ vcpu: 8, ramGb: 2 }).rps
    const b = appCapacityPerInstance({ vcpu: 16, ramGb: 2 }).rps
    expect(b).toBe(a)
  })
  it('database capacity follows vCPU and RAM', () => {
    expect(dbCapacity({ vcpu: 4, ramGb: 16 }).rps).toBe(300)
    expect(dbCapacity({ vcpu: 8, ramGb: 16 }).rps).toBe(320)
  })
  it('scaling doubles vCPU and RAM together and stops at the ends', () => {
    expect(scaleSpec({ vcpu: 4, ramGb: 8 }, 1)).toEqual({ vcpu: 8, ramGb: 16 })
    expect(scaleSpec({ vcpu: 4, ramGb: 8 }, -1)).toEqual({ vcpu: 2, ramGb: 4 })
    expect(scaleSpec({ vcpu: 32, ramGb: 64 }, 1)).toBeNull()
    expect(scaleSpec({ vcpu: 1, ramGb: 2 }, -1)).toBeNull()
  })
  it('bigger instances cost more', () => {
    expect(hourlyCost('appServers', { instances: 2, vcpu: 8, ramGb: 16 })).toBeGreaterThan(hourlyCost('appServers', { instances: 2, vcpu: 4, ramGb: 8 }))
  })
})
