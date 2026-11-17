import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step, type Injected } from './engine'
import { brokerShape, dbHotShare, dbShards, hourlyCost, queueDrain, specLine } from './capacity'
import { runScenario } from './headless'
import { planScenario } from './scenarios'
import { linkShortener } from '../presets/linkShortener'
import { PRESETS } from '../presets/index'
import type { Architecture } from '../store/types'

const feed = PRESETS.find((p) => p.id === 'feed')!.arch
const events = PRESETS.find((p) => p.id === 'events')!.arch
const tweak = (arch: Architecture, id: string, config: Record<string, number>): Architecture => ({ ...arch, components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...config } } : c)) })

function settle(arch: Architecture, seconds: number, injected?: Record<string, Injected>, rps?: number) {
  const a = rps ? tweak(arch, 'client', { rps }) : arch
  let state = freshState()
  let last = step(a, state, 0, { shape: 'steady', injected })
  for (let i = 0; i < seconds * 10; i++) { last = step(a, state, 0.1, { shape: 'steady', injected }); state = last.state }
  return last.result
}

describe('sharded database', () => {
  const db = (cfg: Record<string, number>) => tweak(linkShortener, 'db', cfg)
  it('an unsharded database is unchanged, and a hot key does nothing to it', () => {
    expect(dbShards({})).toBe(1)
    expect(dbHotShare({}, true)).toBe(1)
    expect(settle(db({}), 2, { db: 'hotKey' }).nodes.db.capacity).toBe(300)
  })
  it('an even spread multiplies capacity by the number of shards', () => {
    expect(settle(db({ shards: 4 }), 2).nodes.db.capacity).toBe(1200)
  })
  it('a skewed key limits it to what the busiest shard can do', () => {
    expect(dbHotShare({ shards: 4, hotShare: 0.5 })).toBe(0.5)
    expect(settle(db({ shards: 4, hotShare: 0.5 }), 2).nodes.db.capacity).toBe(600)
  })
  it('a skew below an even spread is ignored', () => {
    expect(dbHotShare({ shards: 4, hotShare: 0.1 })).toBe(0.25)
  })
  it('adding shards does not help a hot key', () => {
    const four = settle(db({ shards: 4, hotShare: 0.5 }), 2).nodes.db.capacity
    const eight = settle(db({ shards: 8, hotShare: 0.5 }), 2).nodes.db.capacity
    expect(eight).toBe(four)
  })
  it('a hot-key fault takes 60% of the traffic to one shard', () => {
    const n = settle(db({ shards: 4 }), 2, { db: 'hotKey' }).nodes.db
    expect(n.shards?.hot).toBe(0.6)
    expect(n.capacity).toBe(500)
  })
  it('every shard is a full database, so cost scales with the shard count', () => {
    expect(hourlyCost('database', { vcpu: 4, ramGb: 16, shards: 4 })).toBeCloseTo(hourlyCost('database', { vcpu: 4, ramGb: 16 }) * 4, 6)
    expect(specLine('database', { vcpu: 4, ramGb: 16, poolSize: 20, shards: 4 })).toMatch(/^4 × 4 vCPU/)
  })
  it('the pool shown is the busiest shard\'s', () => {
    const even = settle(db({ shards: 4 }), 3, undefined, 900).nodes.db
    const hot = settle(db({ shards: 4, hotShare: 0.6 }), 3, undefined, 900).nodes.db
    expect(hot.poolUsed).toBeGreaterThan(even.poolUsed)
  })
  it('is explained as a hot shard', () => {
    const r = settle(feed, 20, { db: 'hotKey' }, 700)
    const i = analyze(feed, r)!
    expect(i.nodeId).toBe('db')
    expect(i.reasons.join(' ')).toMatch(/busiest takes 60%/)
    expect(i.hint).toMatch(/hot key|shard key/)
  })
})

describe('partitioned broker', () => {
  const q = (cfg: Record<string, number>) => ({ capacity: 200, ...cfg })
  it('a plain queue is unchanged', () => {
    expect(queueDrain({ capacity: 400 })).toBe(400)
    expect(queueDrain({ capacity: 400, consumers: 9, poisonPct: 0.1 })).toBe(400) // none of the broker settings apply without partitions
  })
  it('consumers multiply the drain rate, up to the number of partitions', () => {
    expect(queueDrain(q({ partitions: 4, consumers: 2 }))).toBe(400)
    expect(queueDrain(q({ partitions: 4, consumers: 4 }))).toBe(800)
    expect(queueDrain(q({ partitions: 4, consumers: 8 }))).toBe(800)
    expect(brokerShape(q({ partitions: 4, consumers: 8 })).idle).toBe(4)
  })
  it('a hot partition has a single reader, which caps the whole group', () => {
    expect(queueDrain(q({ partitions: 4, consumers: 4, hotKeyShare: 0.5 }))).toBe(400)
    expect(queueDrain(q({ partitions: 4, consumers: 12, hotKeyShare: 0.5 }))).toBe(400) // more consumers do not help
    expect(queueDrain(q({ partitions: 8, consumers: 8, hotKeyShare: 0.5 }))).toBe(400) // neither do more partitions
  })
  it('poison messages without a dead-letter queue block their partition', () => {
    const clean = queueDrain(q({ partitions: 4, consumers: 4 }))
    const poisoned = queueDrain(q({ partitions: 4, consumers: 4, poisonPct: 0.05 }))
    expect(poisoned).toBeCloseTo(clean / (1 + 0.05 * 20), 6)
    const parked = queueDrain(q({ partitions: 4, consumers: 4, poisonPct: 0.05, dlq: 1 }))
    expect(parked).toBeGreaterThan(poisoned * 1.5)
  })
  it('a dead-letter queue collects the poison messages', () => {
    const arch = tweak(events, 'broker', { poisonPct: 0.1, dlq: 1 })
    const n = settle(arch, 10).nodes.broker
    expect(n.broker!.dlqDepth).toBeGreaterThan(100) // about 250 msg/s × 10 % × 10 s
    const without = settle(tweak(events, 'broker', { poisonPct: 0.1 }), 10).nodes.broker
    expect(without.broker!.dlqDepth).toBe(0)
  })
  it('the queue backs up when a hot key makes one partition too slow', () => {
    const calm = tweak(events, 'broker', { hotKeyShare: 0 })
    expect(settle(calm, 20, undefined, 500).nodes.broker.queueDepth).toBe(0)
    const hot = settle(calm, 20, { broker: 'hotKey' }, 500).nodes.broker
    expect(hot.queueDepth).toBeGreaterThan(500)
  })
  it('is explained: extra consumers cannot help a hot partition', () => {
    const arch = tweak(events, 'broker', { consumers: 12 })
    const r = settle(arch, 30, { broker: 'hotKey' }, 400)
    const i = analyze(arch, r)!
    expect(i.nodeId).toBe('broker')
    expect(i.reasons.join(' ')).toMatch(/single consumer|one consumer/)
  })
  it('idle consumers are called out, and cost money', () => {
    const arch = tweak(events, 'broker', { partitions: 2, consumers: 6, capacity: 50 })
    const r = settle(arch, 30, undefined, 400)
    expect(analyze(arch, r)?.reasons.join(' ')).toMatch(/sit idle/)
    expect(hourlyCost('queue', { partitions: 4, consumers: 8 })).toBeGreaterThan(hourlyCost('queue', { partitions: 4, consumers: 2 }))
  })
})

describe('hot partition scenario', () => {
  it('needs something sharded or partitioned', () => {
    expect(planScenario(linkShortener, 'hotPartition').empty).toBeTruthy()
    expect(planScenario(feed, 'hotPartition').injections).toEqual({ db: 'hotKey' })
    expect(planScenario(events, 'hotPartition').injections).toEqual({ broker: 'hotKey' })
  })
  it('the average load looks fine but one shard is overloaded', () => {
    const calm = tweak(feed, 'db', { hotShare: 0 })
    const arch = tweak(calm, 'client', { rps: 700 })
    expect(settle(arch, 10).totals.errorRate).toBeLessThan(0.001) // four even shards handle 1200 rps
    const hot = runScenario(arch, 'hotPartition')
    expect(hot.peakErr).toBeGreaterThan(0.2) // one shard can only take about 500 rps of it
  })
})
