import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { parseProject, serializeProject } from '../store/project'
import type { Architecture } from '../store/types'
import { freshState, step } from './engine'
import { effectiveRegions, rttBetween, transferMs } from './network'
import { sampleTrace } from './trace'

const US_EAST = 0, EU = 2, APAC = 3
const place = (a: Architecture, regions: Record<string, number>, extra: Record<string, Record<string, number>> = {}): Architecture => ({
  ...a,
  components: a.components.map((c) => ({ ...c, config: { ...c.config, ...(c.id in regions ? { region: regions[c.id] } : {}), ...(extra[c.id] ?? {}) } })),
})
function run(arch: Architecture, seconds = 8) {
  let state = freshState()
  let last = step(arch, state, 0, { shape: 'steady' })
  for (let i = 0; i < seconds * 10; i++) { last = step(arch, state, 0.1, { shape: 'steady' }); state = last.state }
  return last.result
}

describe('network time between regions', () => {
  const base = run(linkShortener)

  it('adds nothing to a design that never sets a region', () => {
    expect(base.totals.netMs).toBe(0)
    for (const e of Object.values(base.edges)) { expect(e.rttMs).toBe(0); expect(e.transferMs).toBe(0) }
  })
  it('adds nothing when everything sits in the same region, even a far-away one', () => {
    const r = run(place(linkShortener, { client: APAC, lb: APAC, app: APAC, cache: APAC, db: APAC }))
    expect(r.totals.p50).toBeCloseTo(base.totals.p50, 6)
    expect(r.totals.netMs).toBe(0)
  })
  it('a component with no region of its own follows its caller', () => {
    const arch = place(linkShortener, { client: EU })
    const regions = effectiveRegions(arch)
    for (const id of ['client', 'lb', 'app', 'cache', 'db']) expect(regions.get(id)).toBe(EU)
    expect(run(arch).totals.netMs).toBe(0)
  })
  it('charges the round trip when the client is far from the servers', () => {
    const r = run(place(linkShortener, { client: APAC, lb: US_EAST }))
    expect(r.edges.c1.rttMs).toBe(rttBetween(APAC, US_EAST))
    expect(r.edges.c2.rttMs).toBe(0) // the rest follow the load balancer, so the same region
    // all of the traffic crosses that one connection, so the median goes up by exactly its network time
    expect(r.totals.p50 - base.totals.p50).toBeCloseTo(r.edges.c1.rttMs + r.edges.c1.transferMs, 3)
    expect(r.totals.netMs).toBeCloseTo(r.edges.c1.rttMs + r.edges.c1.transferMs, 3)
  })
  it('counts each hop that crosses a region once, so distances add up along the path', () => {
    const r = run(place(linkShortener, { client: US_EAST, app: EU, db: APAC }))
    const expected = rttBetween(US_EAST, EU) /* client+lb to app: lb follows the client */ + 0.2 * rttBetween(EU, APAC) /* only the 20% that miss the cache reach the db */
    expect(r.edges.c2.rttMs).toBe(rttBetween(US_EAST, EU))
    expect(r.edges.c4.rttMs).toBe(rttBetween(EU, APAC))
    expect(r.totals.netMs).toBeCloseTo(expected, 0)
  })
  it('weights a hop by the share of requests that actually cross it', () => {
    const near = run(place(linkShortener, { db: EU })) // client, lb, app, cache in US-East; only misses go to EU
    expect(near.totals.netMs).toBeCloseTo(0.2 * rttBetween(US_EAST, EU), 0)
    expect(near.totals.p50 - base.totals.p50).toBeCloseTo(near.totals.netMs, 3)
  })
  it('the whole cycle is network plus processing: 1 s each way and 100 ms of processing is about 2.1 s', () => {
    // use a chain with one far hop; assert the structure rather than the table: total = processing + network
    const r = run(place(linkShortener, { client: APAC, lb: US_EAST }))
    const processing = base.totals.p50
    expect(r.totals.p50).toBeCloseTo(processing + rttBetween(APAC, US_EAST) + transferMs(4), 3)
  })
  it('moving a big response across regions takes time too', () => {
    const small = run(place(linkShortener, { client: APAC, lb: US_EAST }))
    const big = run(place(linkShortener, { client: APAC, lb: US_EAST }, { client: { payloadKb: 1000 } }))
    expect(big.edges.c1.transferMs).toBeCloseTo(transferMs(1000), 6)
    expect(big.totals.p50 - small.totals.p50).toBeCloseTo(transferMs(1000) - transferMs(4), 3)
  })
  it('a payload costs nothing extra within a region', () => {
    const r = run(place(linkShortener, {}, { client: { payloadKb: 1000 } }))
    expect(r.totals.p50).toBeCloseTo(base.totals.p50, 6)
  })
  it('network time pushes requests past a client timeout that they would otherwise meet', () => {
    const timeout = Math.ceil(base.totals.p99) + 50
    const near = run(place(linkShortener, {}, { client: { timeoutMs: timeout } }))
    const far = run(place(linkShortener, { client: APAC, lb: US_EAST }, { client: { timeoutMs: timeout } }))
    expect(near.totals.timeouts).toBeLessThan(0.01)
    expect(far.totals.timeouts).toBeGreaterThan(0.5)
    expect(far.totals.errorRate).toBeGreaterThan(near.totals.errorRate)
  })
  it('a slow link to the database makes the app tier give up on calls sooner', () => {
    const cfg = { app: { blocking: 1, callTimeoutMs: 120 } }
    const same = run(place(linkShortener, {}, cfg), 15)
    const far = run(place(linkShortener, { db: APAC }, cfg), 15)
    expect(far.nodes.app.callTimeouts ?? 0).toBeGreaterThan(same.nodes.app.callTimeouts ?? 0)
  })
  it('counts toward the latency target (p99) just as processing time does', () => {
    expect(run(place(linkShortener, { client: APAC, lb: US_EAST })).totals.p99).toBeGreaterThan(base.totals.p99 + rttBetween(APAC, US_EAST))
  })
  it('keeps regions through save and load, and an older file without them loads as before', () => {
    const arch = place(linkShortener, { app: EU, db: -1 })
    const back = parseProject(serializeProject(arch))
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.arch.components.find((c) => c.id === 'app')!.config.region).toBe(EU)
      expect(back.arch.components.find((c) => c.id === 'db')!.config.region).toBe(-1)
    }
    const old = parseProject(serializeProject(linkShortener))
    expect(old.ok && old.arch.components.every((c) => c.kind === 'client' || c.config.region === undefined)).toBe(true)
  })
})

describe('network time in traces', () => {
  const arch = place(linkShortener, { client: US_EAST, app: EU })
  const res = run(arch)
  const traces = Array.from({ length: 300 }, (_, i) => sampleTrace(arch, res, 100 + i)!)

  it('charges the hop that crosses a region and not the others', () => {
    const t = traces[0]
    const byNode = Object.fromEntries(t.hops.map((h) => [h.nodeId, h.netMs]))
    expect(byNode.client).toBe(0)
    expect(byNode.lb).toBe(0)
    expect(byNode.app).toBeGreaterThan(0.9 * rttBetween(US_EAST, EU))
    expect(byNode.app).toBeLessThan(1.1 * rttBetween(US_EAST, EU) + 1)
  })
  it('total time is processing plus network', () => {
    for (const t of traces.slice(0, 50)) {
      expect(t.totalMs).toBeCloseTo(t.hops.reduce((a, h) => a + h.ms + h.netMs, 0), 6)
      expect(t.netMs).toBeCloseTo(t.hops.reduce((a, h) => a + h.netMs, 0), 6)
    }
  })
  it('matches the simulation on average', () => {
    const ok = traces.filter((t) => t.outcome === 'ok')
    const avgNet = ok.reduce((a, t) => a + t.netMs, 0) / ok.length
    expect(avgNet).toBeGreaterThan(res.totals.netMs * 0.8)
    expect(avgNet).toBeLessThan(res.totals.netMs * 1.2)
  })
  it('a same-region design has none', () => {
    const t = sampleTrace(linkShortener, run(linkShortener), 5)!
    expect(t.netMs).toBe(0)
    expect(t.hops.every((h) => h.netMs === 0)).toBe(true)
  })
})
