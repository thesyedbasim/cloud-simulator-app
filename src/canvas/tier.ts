/**
 * Upgrade levels. Every component has a level from 1 to MAX_LEVEL derived from the settings that make it
 * more capable, so its look tells you how upgraded it is at a glance. One module, so the drawing code, the
 * tooltip and the tests all agree on what "level 3" means.
 */
import { configValue, type ArchComponent } from '../store/types'

export const MAX_LEVEL = 6
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 1, 2, 4, 8, 16, 32+ vCPUs map to levels 1 to 6. */
export const cpuLevel = (vcpu: number) => clamp(Math.round(Math.log2(Math.max(1, vcpu))) + 1, 1, MAX_LEVEL)

/** Cache shelves grow with the hit rate (a bigger cache). */
export const cacheLevel = (hitRate: number) => clamp(1 + Math.floor((hitRate - 0.5) / 0.15 + 1e-9), 1, 4)

/** Balancer slabs by number of targets. */
export const balancerLevel = (targets: number) => (targets <= 2 ? 1 : targets <= 4 ? 2 : 3)

/** Queue crates by drain rate: 50 to 2000 msg/s map to 2 to 7. */
export const queueCrates = (drain: number) => clamp(Math.round(Math.log2(Math.max(50, drain) / 50)) + 1, 2, 7)

/** Monitors on the client desk by request rate. */
export const clientMonitors = (rps: number) => 1 + (rps > 150 ? 1 : 0) + (rps > 600 ? 1 : 0) + (rps > 1500 ? 1 : 0)

export function levelOf(c: ArchComponent): number {
  const cfg = c.config
  switch (c.kind) {
    case 'appServers': return cpuLevel(configValue('appServers', cfg, 'vcpu') ?? 4)
    case 'database': return cpuLevel(configValue('database', cfg, 'vcpu') ?? 4)
    case 'cache': return cacheLevel(configValue('cache', cfg, 'hitRate') ?? 0.8)
    case 'loadBalancer': return balancerLevel(configValue('loadBalancer', cfg, 'targets') ?? 2)
    case 'queue': return queueCrates(configValue('queue', cfg, 'capacity') ?? 400) - 1
    case 'client': return clientMonitors(configValue('client', cfg, 'rps') ?? 500)
    case 'serverless': return 1 + ((cfg.memoryMb ?? 512) >= 1024 ? 1 : 0) + ((cfg.memoryMb ?? 512) >= 2048 ? 1 : 0)
    case 'cdn': return cacheLevel(configValue('cdn', cfg, 'hitRate') ?? 0.9)
    case 'bucket': return 1 + ((configValue('bucket', cfg, 'storageGb') ?? 500) >= 200 ? 1 : 0) + ((configValue('bucket', cfg, 'storageGb') ?? 500) >= 2000 ? 1 : 0)
    case 'gateway': return 1 + ((cfg.rateLimit ?? 2000) >= 2000 ? 1 : 0) + ((cfg.rateLimit ?? 2000) >= 5000 ? 1 : 0)
  }
}

/** Highest level a kind can reach, for "Level 3 of 6". */
export const maxLevelOf = (kind: ArchComponent['kind']): number =>
  ({ appServers: MAX_LEVEL, database: MAX_LEVEL, cache: 4, loadBalancer: 3, queue: 5, client: 4, cdn: 4, bucket: 3, gateway: 3, serverless: 3 })[kind]

/** Changes whenever the look of a component would change, so the scene knows when to redraw it. */
export function lookKey(c: ArchComponent): string {
  const cfg = c.config
  const parts: (number | string)[] = [levelOf(c)]
  if (c.kind === 'appServers') parts.push(configValue('appServers', cfg, 'autoscale') ?? 0)
  if (c.kind === 'loadBalancer') parts.push(Math.min(6, configValue('loadBalancer', cfg, 'targets') ?? 2))
  if (c.kind === 'database') parts.push(configValue('database', cfg, 'replicas') ?? 0)
  if (c.kind === 'queue') parts.push(queueCrates(configValue('queue', cfg, 'capacity') ?? 400))
  return `${c.kind}:${parts.join('.')}`
}
