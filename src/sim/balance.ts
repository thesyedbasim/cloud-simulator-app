/**
 * How a load balancer shares traffic between its targets: the balancing policies, the settings that live on a
 * connection (weight, backup, drain), health checking with a detection delay, slow start and draining.
 * Pure functions; the engine calls them once per step for every load balancer.
 */
import type { Connection, ArchComponent } from '../store/types'
import { configValue } from '../store/types'

export const POLICIES = [
  { id: 0, label: 'Round-robin', blurb: 'Every target gets an equal share, whatever its size. A small target can saturate while a big one idles.' },
  { id: 1, label: 'Weighted', blurb: 'Shares follow the weights you set on each connection. Weights stay fixed when a group autoscales.' },
  { id: 2, label: 'Least load', blurb: 'Shares follow each target\'s current capacity, so slow or lost capacity is noticed at once, without waiting for health checks.' },
  { id: 3, label: 'IP hash (sticky)', blurb: 'Each client address always lands on the same target. Few addresses (bots behind one IP) means lopsided load.' },
] as const
export type PolicyId = 0 | 1 | 2 | 3

export const HASH_BUCKETS: Record<number, number> = { 0: 64, 1: 32, 2: 2 } // client type -> how many distinct addresses its traffic comes from

/** Settings on a connection that leaves a load balancer. Stored in `Connection.config`. */
export const CONN_FIELDS = {
  weight: { label: 'Weight', min: 1, max: 10, step: 1, def: 1 },
  backup: { label: 'Backup only', min: 0, max: 1, step: 1, def: 0 },
  drain: { label: 'Draining', min: 0, max: 1, step: 1, def: 0 },
} as const
export type ConnKey = keyof typeof CONN_FIELDS

export const connValue = (e: Pick<Connection, 'config'>, key: ConnKey): number => {
  const f = CONN_FIELDS[key]
  const v = e.config?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, v)) : f.def
}

export interface LbSettings {
  policy: PolicyId
  healthCheck: boolean
  /** Seconds between probes. */
  interval: number
  /** Failed probes in a row before a target is taken out. */
  fails: number
  slowStart: number
  drain: number
}

export function lbSettings(c: Pick<ArchComponent, 'config'>): LbSettings {
  const v = (k: string) => configValue('loadBalancer', c.config, k) ?? 0
  const p = Math.round(v('policy'))
  return { policy: (p >= 0 && p <= 3 ? p : 0) as PolicyId, healthCheck: v('healthCheck') >= 0.5, interval: Math.max(1, v('hcInterval')), fails: Math.max(1, Math.round(v('hcFails'))), slowStart: Math.max(0, v('slowStartSec')), drain: Math.max(0, v('drainSec')) }
}

/** Good probes in a row before a target that was taken out is trusted again. */
export const HEALTHY_AFTER = 2

/** What the load balancer remembers about one of its targets. */
export interface EdgeLb {
  /** Taken out of rotation by health checks. */
  bad: boolean
  fails: number
  oks: number
  nextProbe: number
  /** When it last became (or was put back as) a usable target, for slow start. */
  since: number
  /** When draining began, or null. */
  drainAt: number | null
}
export const freshEdgeLb = (t: number): EdgeLb => ({ bad: false, fails: 0, oks: 0, nextProbe: t, since: -1e9, drainAt: null })

export type TargetStatus = 'active' | 'standby' | 'unhealthy' | 'draining' | 'drained' | 'warming'

/** Move one target's health bookkeeping forward by dt. `down` is whether a probe would fail right now. */
export function advanceEdge(st: EdgeLb, down: boolean, drainOn: boolean, t: number, dt: number, s: LbSettings): EdgeLb {
  let { bad, fails, oks, nextProbe, since, drainAt } = st
  if (!s.healthCheck) { bad = false; fails = 0; oks = 0 }
  else if (dt > 0) {
    for (let guard = 0; t >= nextProbe && guard < 5; guard++) {
      if (down) { fails++; oks = 0; if (!bad && fails >= s.fails) bad = true }
      else { fails = 0; if (bad && ++oks >= HEALTHY_AFTER) { bad = false; oks = 0; since = t } }
      nextProbe += s.interval
    }
    if (t >= nextProbe) nextProbe = t + s.interval
  }
  if (drainOn && drainAt === null) drainAt = t
  if (!drainOn && drainAt !== null) { drainAt = null; since = t }
  return { bad, fails, oks, nextProbe, since, drainAt }
}

/** 0 = gets nothing, 1 = full share. Combines health, slow start and draining. */
export function ramp(st: EdgeLb, drainOn: boolean, t: number, s: LbSettings): number {
  if (st.bad) return 0
  let m = 1
  if (s.slowStart > 0) m *= Math.max(0.05, Math.min(1, (t - st.since) / s.slowStart))
  if (drainOn && st.drainAt !== null) m *= s.drain > 0 ? Math.max(0, 1 - (t - st.drainAt) / s.drain) : 0
  return m
}

export interface Target {
  id: string
  /** Estimated capacity in rps right now. */
  capacity: number
  weight: number
  backup: boolean
  /** From `ramp`. */
  m: number
  draining: boolean
}

/** Which targets take traffic: usable primaries, else usable backups, else (everything is out) all but the drained ones. */
function eligible(ts: Target[], policy: PolicyId): { idx: number[]; backup: boolean; failOpen: boolean } {
  const live = (t: Target) => t.m > 0 && (policy !== 2 || t.capacity > 0)
  const primary = ts.map((t, i) => (!t.backup && live(t) ? i : -1)).filter((i) => i >= 0)
  if (primary.length) return { idx: primary, backup: false, failOpen: false }
  const spare = ts.map((t, i) => (t.backup && live(t) ? i : -1)).filter((i) => i >= 0)
  if (spare.length) return { idx: spare, backup: true, failOpen: false }
  const open = ts.map((t, i) => (!t.draining ? i : -1)).filter((i) => i >= 0)
  return { idx: open.length ? open : ts.map((_, i) => i), backup: false, failOpen: true }
}

function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** The share of one source's traffic each target gets (sums to 1). */
export function split(policy: PolicyId, ts: Target[], src: { id: string; buckets: number }): number[] {
  const out = ts.map(() => 0)
  if (!ts.length) return out
  const { idx, failOpen } = eligible(ts, policy)
  if (policy === 3) {
    // rendezvous hashing: each address picks the highest-scoring target, so removing one only moves its own addresses
    for (let b = 0; b < src.buckets; b++) {
      let best = idx[0], bestScore = -1
      for (const i of idx) { const sc = fnv(`${src.id}|${b}|${ts[i].id}`); if (sc > bestScore) { bestScore = sc; best = i } }
      out[best] += 1 / src.buckets
    }
    return out
  }
  const base = (t: Target) => {
    if (failOpen) return 1
    const w = policy === 0 ? 1 : policy === 1 ? t.weight : Math.max(0, t.capacity)
    return w * t.m
  }
  let total = 0
  for (const i of idx) { out[i] = base(ts[i]); total += out[i] }
  if (total <= 0) { for (const i of idx) out[i] = 1; total = idx.length }
  return out.map((x) => x / total)
}

/** For the inspector and the canvas: what is each target doing right now? */
export function statusOf(t: Target, st: EdgeLb, drainOn: boolean, backupInUse: boolean): TargetStatus {
  if (st.bad) return 'unhealthy'
  if (drainOn) return t.m > 0 ? 'draining' : 'drained'
  if (t.backup && !backupInUse) return 'standby'
  if (t.m < 1) return 'warming'
  return 'active'
}

/** Whether the backups are carrying traffic (every primary is out). */
export const backupsInUse = (ts: Target[], policy: PolicyId) => eligible(ts, policy).backup
