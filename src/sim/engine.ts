/**
 * Simulation engine: pure functions, no React / Pixi imports.
 * Model is documented in docs/MODEL.md. Everything here is deliberately small and approximate.
 */
import type { Architecture, ComponentKind } from '../store/types'
import { appCapacityPerInstance, dbCapacity, hourlyCost } from './capacity'
import { configValue } from '../store/types'

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

const BASE_LATENCY_MS: Record<ComponentKind, number> = { client: 0, loadBalancer: 2, appServers: 25, database: 18, cache: 1, queue: 4 }
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
}
export const freshState = (): SimState => ({ t: 0, retryFactor: 0, queueDepth: {}, scale: {} })

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
  /** Present for autoscaled app tiers. */
  scaling?: { active: number; pending: number; min: number; max: number; warmupSec: number; nextReadyIn: number | null }
}
export interface EdgeResult { rps: number; dropFrac: number }
export interface Totals { p50: number; p99: number; errorRate: number; throughput: number; offered: number; cost: number; retryFactor: number }
export interface StepResult { nodes: Record<string, NodeResult>; edges: Record<string, EdgeResult>; totals: Totals }

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

  const inflow = new Map<string, number>()
  const nodes: Record<string, NodeResult> = {}
  const edgeRes: Record<string, EdgeResult> = {}
  const nextQueue: Record<string, number> = {}
  const nextScale: Record<string, ScaleState> = {}
  const mult = trafficMultiplier(opts.shape, t)
  let completed = 0
  let cost = 0

  for (const id of order) {
    const c = byId.get(id)!
    const cfg = c.config
    const inj = opts.injected?.[id]
    const slow = inj === 'slow' ? SLOW_FACTOR : 1
    const offered = c.kind === 'client' ? (cfg.rps ?? 0) * mult * (1 + prev.retryFactor) : (inflow.get(id) ?? 0)

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
    } else {
      cost += hourlyCost(c.kind, cfg)
    }

    const baseLat = BASE_LATENCY_MS[c.kind] * slow
    let capacity: number
    let poolUsed = 0
    const poolSize = c.kind === 'database' ? (cfg.poolSize ?? 20) : 0
    switch (c.kind) {
      case 'client': capacity = Infinity; break
      case 'loadBalancer': capacity = (cfg.targets ?? 2) * 5000; break
      case 'appServers': capacity = instances * appCapacityPerInstance(cfg).rps; break
      case 'database': capacity = Math.min(dbCapacity(cfg).rps, poolSize / (baseLat / 1000)); break
      case 'cache': capacity = 20000; break
      case 'queue': capacity = cfg.capacity ?? 400; break
    }
    if (inj === 'killed') capacity = 0
    else if (inj === 'lostInstance') {
      const n = instances
      capacity = c.kind === 'appServers' && n > 1 ? (capacity * (n - 1)) / n : 0
    }
    else if (inj === 'slow' && c.kind !== 'database') capacity /= SLOW_FACTOR
    else if (inj === 'slow') capacity = Math.min(capacity, dbCapacity(cfg).rps / SLOW_FACTOR)

    const util = capacity === Infinity ? 0 : capacity === 0 ? (offered > 0 ? 2 : 0) : offered / capacity
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
      served = Math.min(offered, capacity)
      dropped = offered - served
    }

    // latency: simple queueing curve, saturating near 50× base
    const rho = Math.min(util, 0.98)
    let latency = baseLat / (1 - rho)
    if (c.kind === 'queue') latency += (depth / Math.max(1, capacity)) * 1000
    if (util >= 1) latency = Math.max(latency, baseLat * 50)
    if (c.kind === 'database') poolUsed = Math.min(poolSize, served * (latency / 1000))

    let forward = served
    let hit = 0
    if (c.kind === 'cache') {
      hit = cfg.hitRate ?? 0.8
      completed += served * hit
      forward = served * (1 - hit)
    }
    const o = outs.get(id) ?? []
    if (o.length === 0) completed += forward
    else for (const e of o) {
      const f = forward / o.length
      inflow.set(e.to, (inflow.get(e.to) ?? 0) + f)
      edgeRes[e.id] = { rps: f, dropFrac: 0 }
    }

    let health: Health = 'healthy'
    if (c.kind !== 'client') {
      if ((inj && capacity === 0) || util >= 1 || (offered > 0 && dropped > 0.01 * offered)) health = 'failed'
      else if (util >= 0.7) health = 'strained'
    }
    nodes[id] = { offered, served, dropped, util, latency, queueDepth: depth, health, poolUsed, poolSize, hit, injected: inj, down: !!inj && capacity === 0, capacity, scaling }
  }

  for (const e of edges) {
    const tgt = nodes[e.to]
    if (edgeRes[e.id] && tgt) edgeRes[e.id].dropFrac = tgt.offered > 0 ? tgt.dropped / tgt.offered : 0
  }

  let clientOffered = 0
  let dropped = 0
  for (const c of arch.components) {
    const n = nodes[c.id]
    if (c.kind === 'client') clientOffered += n.offered
    dropped += n.dropped
  }
  const errorRate = clientOffered > 0 ? Math.min(1, dropped / clientOffered) : 0
  let p50 = 0
  let p99 = 0
  if (clientOffered > 0) {
    for (const c of arch.components) {
      const n = nodes[c.id]
      const w = n.offered / clientOffered
      const rho = Math.min(Math.max(n.util, 0), 1.2)
      p50 += w * n.latency
      p99 += w * n.latency * (2 + 6 * rho * rho)
    }
  }
  const targetRetry = Math.min(2, errorRate * RETRIES)
  const retryFactor = dt > 0 ? prev.retryFactor + (targetRetry - prev.retryFactor) * 0.2 : prev.retryFactor

  return {
    state: { t, retryFactor, queueDepth: nextQueue, scale: nextScale },
    result: { nodes, edges: edgeRes, totals: { p50: Math.min(p50, 30000), p99: Math.min(p99, 30000), errorRate, throughput: completed, offered: clientOffered, cost, retryFactor } },
  }
}
