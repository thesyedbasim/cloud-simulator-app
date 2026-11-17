/**
 * Simulation engine: pure functions, no React / Pixi imports.
 * Model is documented in docs/MODEL.md. Everything here is deliberately small and approximate.
 */
import type { ArchComponent, Architecture, ComponentKind } from '../store/types'
import { appCapacityPerInstance, dbCapacity, FUNCTION_COLD_START_MS, functionCapacity, functionDurationMs, hourlyCost } from './capacity'
import { configValue } from '../store/types'
import { advanceEdge, backupsInUse, connValue, freshEdgeLb, HASH_BUCKETS, lbSettings, ramp, split, statusOf, type EdgeLb, type Target, type TargetStatus } from './balance'
import { BLOCK_COST, canGeoBlock, geoAllows, loadUnit, regionOf } from './geo'

export type Health = 'healthy' | 'strained' | 'failed'
export type TrafficShape = 'steady' | 'spike' | 'daily' | 'flash' | 'ramp'
/** killed = down; slow = 4× latency and ¼ capacity; lostInstance = one instance of a scaled-out tier dies (a lone instance = down). */
export type Injected = 'killed' | 'slow' | 'lostInstance'

export const SHAPES: { id: TrafficShape; label: string }[] = [
  { id: 'steady', label: 'Steady' },
  { id: 'spike', label: 'Spike' },
  { id: 'daily', label: 'Daily curve' },
  { id: 'flash', label: 'Flash sale' },
  { id: 'ramp', label: 'Slow ramp' },
]

export const CYCLE_S = 60
const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k))

/** Load multiplier at sim time t (seconds). Every shape repeats every CYCLE_S seconds. */
export function trafficMultiplier(shape: TrafficShape, t: number): number {
  const p = t % CYCLE_S
  switch (shape) {
    case 'steady': return 1
    case 'spike': return p < 10 ? 1 : p < 15 ? lerp(1, 3, (p - 10) / 5) : p < 35 ? 3 : p < 40 ? lerp(3, 1, (p - 35) / 5) : 1
    case 'daily': return 1 + 0.6 * Math.sin((2 * Math.PI * p) / CYCLE_S - Math.PI / 2)
    case 'flash': return p < 8 ? 1 : 1 + 3.5 * Math.exp(-(p - 8) / 14)
    case 'ramp': return 0.3 + 2.7 * (p / CYCLE_S)
  }
}

const BASE_LATENCY_MS: Record<ComponentKind, number> = { client: 0, gateway: 6, loadBalancer: 2, appServers: 25, serverless: 100, database: 18, cache: 1, cdn: 8, queue: 4, bucket: 35 }
const RETRIES = 2 // extra attempts a failed request makes
const SLOW_FACTOR = 4

/** Autoscaling bookkeeping for one app tier. */
export interface ScaleState {
  /** Instances serving traffic. */
  active: number
  /** Instances requested but still starting up. */
  pending: { at: number; n: number }[]
  /** Sim time of the last change, for the scale-in cooldown. */
  lastChange: number
}

export interface SimState {
  t: number
  retryFactor: number
  queueDepth: Record<string, number>
  scale: Record<string, ScaleState>
  /** Share of each client's requests that a geo rule turned away last step. A blocked client does not retry. */
  blockedFrac: Record<string, number>
  /** What each load balancer remembers about its targets, by connection id. */
  lb: Record<string, EdgeLb>
  /** Warm function instances (concurrent executions kept ready) per serverless node. */
  warm: Record<string, number>
}
export const freshState = (): SimState => ({ t: 0, retryFactor: 0, queueDepth: {}, scale: {}, blockedFrac: {}, lb: {}, warm: {} })

/** Scale in only after this long without a change, and only if the smaller tier would still be comfortably loaded. */
const SCALE_IN_COOLDOWN_S = 30

export interface NodeResult {
  offered: number
  served: number
  dropped: number
  util: number
  latency: number
  queueDepth: number
  health: Health
  poolUsed: number
  poolSize: number
  hit: number
  injected?: Injected
  /** Capacity is zero because of an injected fault. */
  down: boolean
  /** Effective capacity in rps (Infinity for clients). */
  capacity: number
  /** Requests per second this node's geo rule turned away. They are not errors and are not counted in `offered`. */
  blocked: number
  /** Serverless only: share of requests that started a new instance (a cold start), and executions running right now. */
  cold?: number
  concurrency?: number
  /** Databases only: connections that function instances want, the limit, and whether a pooler shares them. */
  conns?: { demand: number; max: number; pooled: boolean }
  /** Present for autoscaled app tiers. */
  scaling?: { active: number; pending: number; min: number; max: number; warmupSec: number; nextReadyIn: number | null }
}
export interface EdgeResult {
  rps: number
  dropFrac: number
  /** Only on connections that leave a load balancer. */
  lb?: { status: TargetStatus; share: number; bySource: Record<string, number> }
}
/** `blocked` is traffic turned away by geo rules. It is left out of the error rate and the error budget. */
export interface Totals { p50: number; p99: number; errorRate: number; throughput: number; offered: number; cost: number; retryFactor: number; blocked: number }
export interface StepResult { nodes: Record<string, NodeResult>; edges: Record<string, EdgeResult>; totals: Totals }

/** Capacity in rps of a component right now, with any injected fault applied. Shared by the node maths and the balancer's estimate. */
function capacityOf(c: ArchComponent, instances: number, inj: Injected | undefined): number {
  const cfg = c.config
  const baseLat = BASE_LATENCY_MS[c.kind] * (inj === 'slow' ? SLOW_FACTOR : 1)
  let capacity: number
  switch (c.kind) {
    case 'client': capacity = Infinity; break
    case 'loadBalancer': capacity = (cfg.targets ?? 2) * 5000; break
    case 'appServers': capacity = instances * appCapacityPerInstance(cfg).rps; break
    case 'database': capacity = Math.min(dbCapacity(cfg).rps, (cfg.poolSize ?? 20) / (baseLat / 1000)); break
    case 'cache': capacity = 20000; break
    case 'serverless': capacity = functionCapacity(cfg); break
    case 'cdn': capacity = 50000; break
    case 'bucket': capacity = (cfg.prefixes ?? 1) * 5500; break // roughly what object storage allows per key prefix
    case 'gateway': capacity = (configValue('gateway', cfg, 'limitOn') ?? 1) >= 0.5 ? (cfg.rateLimit ?? 2000) : 20000; break
    case 'queue': capacity = cfg.capacity ?? 400; break
  }
  if (inj === 'killed') capacity = 0
  else if (inj === 'lostInstance') capacity = c.kind === 'appServers' && instances > 1 ? (capacity * (instances - 1)) / instances : 0
  else if (inj === 'slow' && c.kind !== 'database') capacity /= SLOW_FACTOR
  else if (inj === 'slow') capacity = Math.min(capacity, dbCapacity(cfg).rps / SLOW_FACTOR)
  return capacity
}

export function step(arch: Architecture, prev: SimState, dt: number, opts: { shape: TrafficShape; injected?: Record<string, Injected> }): { state: SimState; result: StepResult } {
  const t = prev.t + dt
  const byId = new Map(arch.components.map((c) => [c.id, c]))
  const edges = arch.connections.filter((e) => byId.has(e.from) && byId.has(e.to))
  const outs = new Map<string, typeof edges>()
  const indeg = new Map<string, number>(arch.components.map((c) => [c.id, 0]))
  for (const e of edges) {
    outs.set(e.from, [...(outs.get(e.from) ?? []), e])
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }

  // Kahn ordering; nodes stuck in cycles are appended so they still get processed once.
  const order: string[] = []
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id)
  const deg = new Map(indeg)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const e of outs.get(id) ?? []) {
      deg.set(e.to, deg.get(e.to)! - 1)
      if (deg.get(e.to) === 0) queue.push(e.to)
    }
  }
  for (const c of arch.components) if (!order.includes(c.id)) order.push(c.id)

  /** Requests per second arriving at each node, kept per originating client so geo rules can tell them apart. */
  const inflow = new Map<string, Map<string, number>>()
  const nodes: Record<string, NodeResult> = {}
  const edgeRes: Record<string, EdgeResult> = {}
  const nextQueue: Record<string, number> = {}
  const nextScale: Record<string, ScaleState> = {}
  const nextLb: Record<string, EdgeLb> = {}
  const nextWarm: Record<string, number> = {}
  const blockedBySrc: Record<string, number> = {}
  const mult = trafficMultiplier(opts.shape, t)
  let completed = 0
  let cost = 0

  for (const id of order) {
    const c = byId.get(id)!
    const cfg = c.config
    const inj = opts.injected?.[id]
    const slow = inj === 'slow' ? SLOW_FACTOR : 1
    const arriving: Map<string, number> = c.kind === 'client' ? new Map([[id, (cfg.rps ?? 0) * mult * (1 + prev.retryFactor * (1 - (prev.blockedFrac?.[id] ?? 0)))]]) : (inflow.get(id) ?? new Map())

    // Geo rule: traffic from a turned-away region never reaches the capacity maths below, apart from the small
    // cost of saying no (cheap at a load balancer, a little more at an app tier).
    const allowed = new Map<string, number>()
    let blocked = 0
    for (const [src, rps] of arriving) {
      const sc = byId.get(src)
      if (canGeoBlock(c.kind) && sc && !geoAllows(c, regionOf(sc))) { blocked += rps; blockedBySrc[src] = (blockedBySrc[src] ?? 0) + rps }
      else allowed.set(src, rps)
    }
    let offered = 0
    let unitLoad = 0 // capacity units: a request from a heavy or write-heavy client counts for more
    for (const [src, rps] of allowed) {
      offered += rps
      const sc = byId.get(src)
      unitLoad += rps * (sc ? loadUnit(c.kind, sc, c) : 1)
    }
    const unit = offered > 0 ? unitLoad / offered : 1
    const blockLoad = canGeoBlock(c.kind) ? blocked * BLOCK_COST[c.kind as keyof typeof BLOCK_COST] : 0

    // Autoscaling: instances are requested when load is high, and only start serving after the start-up delay.
    let instances = cfg.instances ?? 1
    let scaling: NodeResult['scaling']
    if (c.kind === 'appServers' && (configValue('appServers', cfg, 'autoscale') ?? 0) >= 0.5) {
      const min = cfg.instances ?? 1
      const max = Math.max(min, configValue('appServers', cfg, 'maxInstances') ?? 8)
      const warmup = configValue('appServers', cfg, 'warmupSec') ?? 30
      const target = configValue('appServers', cfg, 'scaleUpAt') ?? 0.7
      const per = appCapacityPerInstance(cfg).rps
      const sc = prev.scale[id] ?? { active: min, pending: [] as ScaleState['pending'], lastChange: -1e9 }
      let active = sc.active
      let lastChange = sc.lastChange
      const pending: ScaleState['pending'] = []
      for (const p of sc.pending) { if (p.at <= t) { active += p.n; lastChange = t } else pending.push(p) }
      active = Math.min(max, Math.max(min, active))
      const pendingN = pending.reduce((a, p) => a + p.n, 0)
      // A lost instance still counts towards the group's size but serves nothing, so it is replaced like any
      // unhealthy instance. A tier that is entirely down cannot be helped by more instances, so it does not scale.
      const dead = inj === 'lostInstance' ? 1 : 0
      if (dt > 0 && inj !== 'killed') {
        const need = Math.ceil(offered / (per * target)) // healthy instances needed to run at the target load
        const healthy = active - dead + pendingN
        const add = Math.min(need - healthy, max - active - pendingN)
        if (add > 0) {
          pending.push({ at: t + warmup, n: add })
          lastChange = t
        } else if (dead === 0 && pendingN === 0 && active > min && t - lastChange > SCALE_IN_COOLDOWN_S && offered < per * (active - 1) * (target - 0.05)) { // hysteresis: only if the smaller tier would sit clearly below the scale-out line
          active -= 1
          lastChange = t
        }
      }
      nextScale[id] = { active, pending, lastChange }
      instances = active
      const pn = pending.reduce((a, p) => a + p.n, 0)
      scaling = { active, pending: pn, min, max, warmupSec: warmup, nextReadyIn: pending.length ? Math.max(0, Math.min(...pending.map((p) => p.at)) - t) : null }
      cost += hourlyCost(c.kind, { ...cfg, instances: active + pn }) // starting instances already cost money
    } else if (c.kind !== 'serverless') {
      cost += hourlyCost(c.kind, cfg)
    }

    const baseLat = BASE_LATENCY_MS[c.kind] * slow
    let poolUsed = 0
    const poolSize = c.kind === 'database' ? (cfg.poolSize ?? 20) : 0
    let capacity = capacityOf(c, instances, inj)

    // Function instances each hold a database connection while they run. Without a pooler, more of them than the
    // database allows means the extra requests are refused; a pooler shares a few connections between them all.
    let conns: NodeResult['conns']
    if (c.kind === 'database') {
      let demand = 0
      for (const e of edges) {
        const u = nodes[e.from]
        if (e.to === id && byId.get(e.from)?.kind === 'serverless' && u && u.served > 0) demand += (u.concurrency ?? 0) * ((edgeRes[e.id]?.rps ?? 0) / u.served)
      }
      const pooled = (configValue('database', cfg, 'pooler') ?? 0) >= 0.5
      conns = { demand, max: poolSize, pooled }
      if (!pooled && demand > poolSize) capacity = Math.min(capacity, offered * (poolSize / demand))
    }

    const util = capacity === Infinity ? 0 : capacity === 0 ? (offered > 0 ? 2 : 0) : (unitLoad + blockLoad) / capacity
    let served: number
    let dropped: number
    let depth = 0
    if (c.kind === 'queue') {
      const maxDepth = cfg.maxDepth ?? 2000
      const prevDepth = prev.queueDepth[id] ?? 0
      let d = Math.max(0, prevDepth + (offered - capacity) * dt)
      let overflow = 0
      if (d > maxDepth) { overflow = dt > 0 ? (d - maxDepth) / dt : 0; d = maxDepth }
      depth = d
      dropped = Math.min(offered, overflow)
      served = Math.max(0, offered - dropped - (dt > 0 ? (d - prevDepth) / dt : 0))
      nextQueue[id] = d
    } else {
      served = Math.min(offered, Math.max(0, capacity - blockLoad) / unit)
      dropped = offered - served
    }

    // latency: simple queueing curve, saturating near 50× base
    const rho = Math.min(util, 0.98)
    let latency = baseLat / (1 - rho)
    if (c.kind === 'queue') latency += (depth / Math.max(1, capacity)) * 1000
    if (util >= 1) latency = Math.max(latency, baseLat * 50)
    if (c.kind === 'gateway' && !inj) latency = baseLat // turning a request away is quick; it does not queue
    let cold: number | undefined
    let concurrency: number | undefined
    if (c.kind === 'serverless') {
      // No queueing until the concurrency limit. Cold starts happen when load grows faster than warm instances exist:
      // every new instance serves its first request slowly.
      const dur = functionDurationMs(cfg) * slow
      const limit = cfg.concurrency ?? 1000
      const need = Math.min(limit, offered * (dur / 1000))
      const provisioned = Math.min(limit, configValue('serverless', cfg, 'provisioned') ?? 0)
      const had = Math.max(prev.warm[id] ?? need, provisioned)
      const created = inj === 'killed' ? 0 : Math.max(0, need - had)
      cold = dt > 0 && offered > 0 ? Math.min(1, created / (offered * dt)) : 0
      nextWarm[id] = dt > 0 ? Math.max(need, provisioned, had - (had * dt) / 60) : had // idle instances are reclaimed over about a minute
      concurrency = Math.min(need, served * (dur / 1000))
      latency = dur + cold * FUNCTION_COLD_START_MS
      cost += hourlyCost(c.kind, { ...cfg, rps: served })
    }
    if (c.kind === 'database') {
      poolUsed = Math.min(poolSize, served * (latency / 1000))
      if (conns && !conns.pooled) poolUsed = Math.min(poolSize, Math.max(poolUsed, conns.demand)) // idle connections held by functions still count
      if (conns?.pooled && conns.demand > 0) latency += 2 // waiting for a pooled connection
    }

    let forward = served
    let hit = 0
    if (c.kind === 'cache' || c.kind === 'cdn') {
      hit = cfg.hitRate ?? 0.8
      completed += served * hit
      forward = served * (1 - hit)
    }
    const o = outs.get(id) ?? []
    const passed = offered > 0 ? forward / offered : 0 // every source loses the same share to drops and cache hits
    if (o.length === 0) completed += forward
    else {
      // Share each source's traffic between the outgoing connections. Only a load balancer does anything but split evenly.
      let fractions: (srcId: string) => number[] = () => o.map(() => 1 / o.length)
      let lbInfo: { status: TargetStatus }[] | null = null
      if (c.kind === 'loadBalancer') {
        const s = lbSettings(c)
        const ts: Target[] = []
        const sts: EdgeLb[] = []
        const drains: boolean[] = []
        for (const e of o) {
          const tc = byId.get(e.to)!
          const tInj = opts.injected?.[e.to]
          const tInst = tc.kind === 'appServers' && (configValue('appServers', tc.config, 'autoscale') ?? 0) >= 0.5 ? (prev.scale[tc.id]?.active ?? tc.config.instances ?? 1) : (tc.config.instances ?? 1)
          const cap = capacityOf(tc, tInst, tInj)
          const drainOn = connValue(e, 'drain') >= 0.5
          const st = advanceEdge(prev.lb[e.id] ?? freshEdgeLb(prev.t), cap === 0, drainOn, t, dt, s)
          nextLb[e.id] = st
          sts.push(st); drains.push(drainOn)
          ts.push({ id: e.to, capacity: cap, weight: connValue(e, 'weight'), backup: connValue(e, 'backup') >= 0.5, m: ramp(st, drainOn, t, s), draining: drainOn })
        }
        const cache = new Map<string, number[]>()
        fractions = (srcId) => {
          const sc = byId.get(srcId)
          const key = s.policy === 3 ? srcId : ''
          let f = cache.get(key)
          if (!f) { f = split(s.policy, ts, { id: srcId, buckets: HASH_BUCKETS[Math.round(sc ? (configValue('client', sc.config, 'clientType') ?? 0) : 0)] ?? 64 }); cache.set(key, f) }
          return f
        }
        const inUse = backupsInUse(ts, s.policy)
        lbInfo = ts.map((t2, i) => ({ status: statusOf(t2, sts[i], drains[i], inUse) }))
      }
      o.forEach((e, i) => {
        const bySource: Record<string, number> = {}
        let rps = 0
        for (const [src, r] of allowed) { const v = r * passed * fractions(src)[i]; bySource[src] = v; rps += v }
        const dest = inflow.get(e.to) ?? new Map<string, number>()
        for (const [src, v] of Object.entries(bySource)) dest.set(src, (dest.get(src) ?? 0) + v)
        inflow.set(e.to, dest)
        edgeRes[e.id] = { rps, dropFrac: 0, ...(lbInfo ? { lb: { status: lbInfo[i].status, share: 0, bySource } } : {}) }
      })
      if (lbInfo) {
        const all = o.reduce((a, e) => a + edgeRes[e.id].rps, 0)
        o.forEach((e, i) => { edgeRes[e.id].lb!.share = all > 0 ? edgeRes[e.id].rps / all : fractions('')[i] ?? 0 })
      }
    }

    let health: Health = 'healthy'
    if (c.kind !== 'client') {
      // A gateway that is rate limiting is doing its job: it shows as strained, not broken.
      const limiting = c.kind === 'gateway' && !inj
      if ((inj && capacity === 0) || (!limiting && (util >= 1 || (offered > 0 && dropped > 0.01 * offered)))) health = 'failed'
      else if (util >= 0.7 || (limiting && dropped > 0.01 * offered)) health = 'strained'
    }
    nodes[id] = { offered, served, dropped, util, latency, queueDepth: depth, health, poolUsed, poolSize, hit, injected: inj, down: !!inj && capacity === 0, capacity, blocked, cold, concurrency, conns, scaling }
  }

  for (const e of edges) {
    const tgt = nodes[e.to]
    if (edgeRes[e.id] && tgt) edgeRes[e.id].dropFrac = tgt.offered > 0 ? tgt.dropped / tgt.offered : 0
  }

  let clientOffered = 0
  let dropped = 0
  let blockedTotal = 0
  for (const c of arch.components) {
    const n = nodes[c.id]
    if (c.kind === 'client') clientOffered += n.offered
    dropped += n.dropped
    blockedTotal += n.blocked
  }
  // Blocked requests were turned away on purpose, so they are neither errors nor part of what must succeed.
  const legit = Math.max(0, clientOffered - blockedTotal)
  const errorRate = legit > 0 ? Math.min(1, dropped / legit) : 0
  let p50 = 0
  let p99 = 0
  if (legit > 0) {
    for (const c of arch.components) {
      const n = nodes[c.id]
      const w = Math.min(1, n.offered / legit)
      const rho = c.kind === 'gateway' || c.kind === 'serverless' ? 0 : Math.min(Math.max(n.util, 0), 1.2)
      p50 += w * n.latency
      p99 += w * (n.latency * (2 + 6 * rho * rho) + ((n.cold ?? 0) > 0.01 ? FUNCTION_COLD_START_MS : 0)) // a few cold requests already set the tail
    }
  }
  const blockedFrac: Record<string, number> = {}
  for (const [src, rps] of Object.entries(blockedBySrc)) { const o = nodes[src]?.offered ?? 0; if (o > 0) blockedFrac[src] = Math.min(1, rps / o) }
  const targetRetry = Math.min(2, errorRate * RETRIES)
  const retryFactor = dt > 0 ? prev.retryFactor + (targetRetry - prev.retryFactor) * 0.2 : prev.retryFactor

  return {
    state: { t, retryFactor, queueDepth: nextQueue, scale: nextScale, blockedFrac, lb: nextLb, warm: nextWarm },
    result: { nodes, edges: edgeRes, totals: { p50: Math.min(p50, 30000), p99: Math.min(p99, 30000), errorRate, throughput: completed, offered: clientOffered, cost, retryFactor, blocked: blockedTotal } },
  }
}
