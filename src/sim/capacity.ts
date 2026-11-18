/**
 * How hardware settings turn into capacity and cost. Pure functions shared by the engine and the UI,
 * so the inspector can explain exactly what the simulator will do with a setting.
 */
import type { ComponentKind } from '../store/types'
import { configValue } from '../store/types'
import { EGRESS_USD_PER_GB, REGIONS } from './geo'

const RPS_PER_VCPU_APP = 125 // CPU-bound request handling
const RPS_PER_GB_APP = 100 // memory-bound concurrency (sessions, buffers)
const RPS_PER_VCPU_DB = 75
const RPS_PER_GB_DB = 20

/** A cold start adds this much to a request that needs a brand-new function instance. */
export const FUNCTION_COLD_START_MS = 400

/** Memory at which a function gets one full vCPU (as on AWS Lambda). Memory sets CPU: a function with more memory also has more cores. */
export const MB_PER_VCPU = 1769
/** The shortest a call can take, whatever the settings. */
export const MIN_RUN_MS = 25

/** What one execution of an application needs. A request with no application of its own uses `DEFAULT_PROFILE`. */
export interface RunProfile { runMs: number; memoryMb: number; cores: number }
export const DEFAULT_PROFILE: RunProfile = { runMs: 100, memoryMb: 128, cores: 0.25 }

/** vCPUs a function with this much memory has. */
export const coresOf = (memoryMb: number) => memoryMb / MB_PER_VCPU

/**
 * How one execution fares on a function with `memoryMb`. `runMs` is its time when it has the cores it needs. With fewer cores than that
 * it runs proportionally slower (needs 1 core, has 0.5: twice as long). Needing more memory than the function has makes it fail (out of memory).
 * Extra memory beyond what the application needs does not make it faster.
 */
export function runOn(p: RunProfile, memoryMb: number): { ms: number; slowdown: number; oom: boolean } {
  const slowdown = Math.max(1, p.cores / coresOf(memoryMb))
  return { ms: Math.max(MIN_RUN_MS, p.runMs * slowdown), slowdown, oom: p.memoryMb > memoryMb }
}

/**
 * Run time of an invocation. `avgRunMs` in the config is what the simulation worked out from the applications that actually
 * arrive (it is absent for a plain function, which runs the default profile).
 */
export function functionDurationMs(c: Record<string, number>): number {
  return c.avgRunMs ?? runOn(DEFAULT_PROFILE, c.memoryMb ?? 512).ms
}
/** Requests per second the concurrency limit allows. */
export const functionCapacity = (c: Record<string, number>) => (c.concurrency ?? 1000) / (functionDurationMs(c) / 1000)
/** $/hour: per request plus per GB-second of run time, plus the always-warm instances. Pass the request rate as `rps`. */
export function functionCost(c: Record<string, number>): number {
  const gb = (c.memoryMb ?? 512) / 1024
  const perRequest = 0.2 / 1e6 + gb * (functionDurationMs(c) / 1000) * 0.0000166667
  return (c.rps ?? 0) * 3600 * perRequest + (c.provisioned ?? 0) * gb * 0.0000041667 * 3600
}

export type Limiter = 'CPU' | 'RAM'

/** A hot key sends this share of a sharded store's or a partitioned queue's traffic to one shard or partition. An assumed figure. */
export const HOT_KEY_SHARE = 0.6
/** A poison message is retried this many times before it is given up on (or sent to the dead-letter queue after one failure). */
export const POISON_RETRY_COST = 20

export const dbShards = (c: Record<string, number>) => Math.max(1, Math.round(c.shards ?? 1))
/** Share of a database's traffic that lands on its busiest shard (1 for an unsharded database). */
export function dbHotShare(c: Record<string, number>, hotKey = false): number {
  const s = dbShards(c)
  if (s === 1) return 1
  return Math.min(1, Math.max(1 / s, c.hotShare ?? 0, hotKey ? HOT_KEY_SHARE : 0))
}

/** Partitioned queues (a broker with a consumer group): partitions, consumers, and the busiest partition's share. */
export const isBroker = (c: Record<string, number>) => Math.round(c.partitions ?? 0) > 0
export function brokerShape(c: Record<string, number>, hotKey = false) {
  const partitions = Math.max(1, Math.round(c.partitions ?? 1))
  const consumers = Math.max(1, Math.round(c.consumers ?? 1))
  const active = Math.min(consumers, partitions) // a partition is read by one consumer in the group, so extra consumers sit idle
  const hot = Math.min(1, Math.max(1 / partitions, c.hotKeyShare ?? 0, hotKey ? HOT_KEY_SHARE : 0))
  return { partitions, consumers, active, hot, idle: Math.max(0, consumers - partitions) }
}
/** Messages per second a queue can drain right now. */
export function queueDrain(c: Record<string, number>, hotKey = false): number {
  const rate = c.capacity ?? 400
  if (!isBroker(c)) return rate
  const b = brokerShape(c, hotKey)
  let drain = Math.min(b.active * rate, rate / b.hot) // the busiest partition has one reader, so it caps the whole group
  const poison = c.poisonPct ?? 0
  drain /= 1 + poison * ((c.dlq ?? 0) >= 0.5 ? 1 : POISON_RETRY_COST) // a poison message with no dead-letter queue is retried over and over, holding up its partition
  return drain
}

export function appCapacityPerInstance(c: Record<string, number>): { rps: number; limiter: Limiter } {
  const cpu = (c.vcpu ?? 4) * RPS_PER_VCPU_APP
  const mem = (c.ramGb ?? 8) * RPS_PER_GB_APP
  return { rps: Math.min(cpu, mem), limiter: cpu <= mem ? 'CPU' : 'RAM' }
}

export function dbCapacity(c: Record<string, number>): { rps: number; limiter: Limiter } {
  const cpu = (c.vcpu ?? 4) * RPS_PER_VCPU_DB
  const mem = (c.ramGb ?? 16) * RPS_PER_GB_DB
  return { rps: Math.min(cpu, mem), limiter: cpu <= mem ? 'CPU' : 'RAM' }
}

/** Estimated $/hour. Always shown as an estimate. */
export function hourlyCost(kind: ComponentKind, c: Record<string, number>): number {
  switch (kind) {
    case 'client': return ((c.rps ?? 0) * 3600 * (configValue('client', c, 'payloadKb') ?? 4)) / 1e6 * EGRESS_USD_PER_GB // data transfer out
    case 'loadBalancer': return 0.03
    case 'appServers': return (c.instances ?? 1) * ((c.vcpu ?? 4) * 0.03 + (c.ramGb ?? 8) * 0.005)
    case 'database': return (((c.vcpu ?? 4) * 0.06 + (c.ramGb ?? 16) * 0.01) * (1 + (c.replicas ?? 0)) + ((c.pooler ?? 0) >= 0.5 ? (c.vcpu ?? 4) * 0.015 : 0)) * dbShards(c) // each replica is a full copy; a proxy is billed per vCPU; every shard is a full database
    case 'cache': return 0.03 + 0.04 * Math.pow((c.hitRate ?? 0.8) / 0.8, 3) // a bigger cache (higher hit rate) costs more
    case 'queue': return 0.04 + (isBroker(c) ? 0.03 * Math.round(c.consumers ?? 1) + 0.01 * Math.round(c.partitions ?? 1) : 0)
    case 'cdn': return 0.04 + 0.06 * Math.pow((c.hitRate ?? 0.9) / 0.9, 3)
    case 'bucket': return 0.01 + ((c.storageGb ?? 500) * 0.023) / 730 // storage billed per GB-month
    case 'gateway': return 0.05
    case 'serverless': return functionCost(c)
  }
}

/** One-line hardware summary, e.g. "2 × 4 vCPU · 8 GB". */
export function specLine(kind: ComponentKind, c: Record<string, number>): string {
  switch (kind) {
    case 'appServers': return `${(c.autoscale ?? 0) >= 0.5 ? `${c.instances ?? 1}–${c.maxInstances ?? 8}` : (c.instances ?? 1)} × ${c.vcpu ?? 4} vCPU · ${c.ramGb ?? 8} GB`
    case 'database': return `${dbShards(c) > 1 ? `${dbShards(c)} × ` : ''}${c.vcpu ?? 4} vCPU · ${c.ramGb ?? 16} GB · pool ${c.poolSize ?? 20}${(c.replicas ?? 0) > 0 ? ` · ${c.replicas} replica${c.replicas === 1 ? '' : 's'}` : ''}${(c.pooler ?? 0) >= 0.5 ? ' · proxy' : ''}`
    case 'cache': return `${Math.round((c.hitRate ?? 0.8) * 100)}% hit rate`
    case 'queue': return isBroker(c) ? `${Math.round(c.partitions ?? 1)} partitions · ${Math.round(c.consumers ?? 1)} consumer${Math.round(c.consumers ?? 1) === 1 ? '' : 's'}` : `drain ${c.capacity ?? 400}/s`
    case 'cdn': return `${Math.round((c.hitRate ?? 0.9) * 100)}% hit rate`
    case 'bucket': return `${c.storageGb ?? 500} GB · ${c.prefixes ?? 1} prefix${(c.prefixes ?? 1) === 1 ? '' : 'es'}`
    case 'serverless': return `${c.memoryMb ?? 512} MB · up to ${c.concurrency ?? 1000} at once`
    case 'gateway': return (c.limitOn ?? 1) >= 0.5 ? `limit ${c.rateLimit ?? 2000} rps` : 'no rate limit'
    case 'loadBalancer': return `${c.targets ?? 2} targets`
    case 'client': return `${c.rps ?? 0} rps · ${REGIONS[Math.round(configValue('client', c, 'region') ?? 0)]?.label ?? REGIONS[0].label}`
  }
}

/** Ladder used by Scale up / Scale down: doubles or halves vCPU and RAM together. */
export const VCPU_STEPS = [1, 2, 4, 8, 16, 32]
export function scaleSpec(c: Record<string, number>, dir: 1 | -1): { vcpu: number; ramGb: number } | null {
  const vcpu = c.vcpu ?? 4
  const ramGb = c.ramGb ?? 8
  const i = VCPU_STEPS.indexOf(vcpu)
  const next = i === -1 ? VCPU_STEPS.find((s) => (dir === 1 ? s > vcpu : s < vcpu)) : VCPU_STEPS[i + dir]
  if (!next) return null
  const ratio = ramGb / vcpu
  return { vcpu: next, ramGb: Math.min(128, Math.max(1, Math.round(ratio * next))) }
}
