/**
 * How hardware settings turn into capacity and cost. Pure functions shared by the engine and the UI,
 * so the inspector can explain exactly what the simulator will do with a setting.
 */
import type { ComponentKind } from '../store/types'

const RPS_PER_VCPU_APP = 125 // CPU-bound request handling
const RPS_PER_GB_APP = 100 // memory-bound concurrency (sessions, buffers)
const RPS_PER_VCPU_DB = 75
const RPS_PER_GB_DB = 20

export type Limiter = 'CPU' | 'RAM'

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
    case 'client': return 0
    case 'loadBalancer': return 0.03
    case 'appServers': return (c.instances ?? 1) * ((c.vcpu ?? 4) * 0.03 + (c.ramGb ?? 8) * 0.005)
    case 'database': return (c.vcpu ?? 4) * 0.06 + (c.ramGb ?? 16) * 0.01
    case 'cache': return 0.03 + 0.04 * Math.pow((c.hitRate ?? 0.8) / 0.8, 3) // a bigger cache (higher hit rate) costs more
    case 'queue': return 0.04
  }
}

/** One-line hardware summary, e.g. "2 × 4 vCPU · 8 GB". */
export function specLine(kind: ComponentKind, c: Record<string, number>): string {
  switch (kind) {
    case 'appServers': return `${(c.autoscale ?? 0) >= 0.5 ? `${c.instances ?? 1}–${c.maxInstances ?? 8}` : (c.instances ?? 1)} × ${c.vcpu ?? 4} vCPU · ${c.ramGb ?? 8} GB`
    case 'database': return `${c.vcpu ?? 4} vCPU · ${c.ramGb ?? 16} GB · pool ${c.poolSize ?? 20}`
    case 'cache': return `${Math.round((c.hitRate ?? 0.8) * 100)}% hit rate`
    case 'queue': return `drain ${c.capacity ?? 400}/s`
    case 'loadBalancer': return `${c.targets ?? 2} targets`
    case 'client': return `${c.rps ?? 0} rps`
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
