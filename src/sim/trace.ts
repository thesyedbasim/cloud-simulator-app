/**
 * Request tracing: follow ONE request through the architecture. The path, each hop's latency and whether the
 * request survives are drawn at random from the simulation's current numbers (edge splits, cache hit rate,
 * per-node drop probability and latency), so over many traces the results match the aggregate metrics.
 */
import type { Architecture, ComponentKind } from '../store/types'
import type { NodeResult, StepResult } from './engine'
import { FUNCTION_COLD_START_MS } from './capacity'
import { describeGeo, geoAllows, regionOf, REGIONS } from './geo'
import { configValue } from '../store/types'

export interface Hop {
  nodeId: string
  name: string
  kind: ComponentKind
  /** Time spent at this hop, processing the request. */
  ms: number
  /** Time spent on the network getting here from the previous hop, and carrying the response back: 0 within a region. */
  netMs: number
  outcome: 'ok' | 'hit' | 'dropped' | 'blocked'
  note: string
}

/** What kind of request is traced. 'any' is a typical request and applies no read/write rules. */
export type TraceType = 'any' | 'read' | 'write' | 'upload'

export interface Trace {
  id: number
  type: TraceType
  hops: Hop[]
  /** edges[i] connects hops[i] to hops[i + 1]. */
  edges: string[]
  /** 'blocked' means a geo rule turned it away on purpose, which is not a failure. */
  outcome: 'ok' | 'dropped' | 'blocked'
  failedAt: string | null
  /** Everything: processing at each hop plus network time. */
  totalMs: number
  /** The network part of `totalMs`. */
  netMs: number
  /** One sentence describing how it ended. */
  summary: string
}

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MAX_HOPS = 30
const timeOf = (hops: Hop[]) => hops.reduce((a, h) => a + h.ms + h.netMs, 0)
const netOf = (hops: Hop[]) => hops.reduce((a, h) => a + h.netMs, 0)

function whyDropped(n: NodeResult, kind: ComponentKind): string {
  if (n.down) return 'it is down'
  if (n.injected === 'slow') return 'it is too slow to keep up'
  if (kind === 'queue') return 'the queue is full'
  if (kind === 'serverless') return 'it hit its concurrency limit (429 Too Many Requests)'
  if (kind === 'gateway') return 'it is over its rate limit (429 Too Many Requests)'
  if (kind === 'bucket') return 'the bucket is throttling requests (503 Slow Down): too many for its key prefixes'
  if (kind === 'database' && n.conns && !n.conns.pooled && n.conns.demand > n.conns.max) return 'there are no free connections (too many function instances, and no connection pooler)'
  if (kind === 'database' && n.poolSize > 0 && n.poolUsed >= n.poolSize * 0.9) return 'the connection pool is exhausted'
  return `it is over capacity (${Math.round(n.util * 100)}% load)`
}

function walk(arch: Architecture, res: StepResult, rand: () => number, id: number, from?: string, type: TraceType = 'any'): Trace | null {
  const byId = new Map(arch.components.map((c) => [c.id, c]))
  const out = new Map<string, { id: string; to: string }[]>()
  for (const e of arch.connections) out.set(e.from, [...(out.get(e.from) ?? []), { id: e.id, to: e.to }])

  // an upload heads for storage: remember which nodes lead to a bucket or a queue
  const toStore = new Set<string>()
  if (type === 'upload') {
    for (const c of arch.components) if (c.kind === 'bucket' || c.kind === 'queue') toStore.add(c.id)
    for (let grew = true; grew;) { grew = false; for (const e of arch.connections) if (toStore.has(e.to) && !toStore.has(e.from)) { toStore.add(e.from); grew = true } }
  }

  // start at a client, weighted by how much traffic each sends
  const clients = arch.components.filter((c) => c.kind === 'client' && out.has(c.id))
  if (!clients.length) return null
  const weights = clients.map((c) => Math.max(1, res.nodes[c.id]?.offered ?? 1))
  let pick = rand() * weights.reduce((a, b) => a + b, 0)
  let cur = clients[0]
  for (let i = 0; i < clients.length; i++) { pick -= weights[i]; if (pick <= 0) { cur = clients[i]; break } }
  const chosen = from ? clients.find((c) => c.id === from) : undefined
  if (chosen) cur = chosen

  const origin = cur
  const hops: Hop[] = []
  const edges: string[] = []
  for (let guard = 0; guard < MAX_HOPS; guard++) {
    const n = res.nodes[cur.id]
    if (!n) return null
    if (cur.kind === 'client') {
      hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: 0, netMs: 0, outcome: 'ok', note: `sends the request from ${REGIONS[regionOf(cur)].label}` })
    } else {
      // getting here: the connection's round trip and the response's transfer, a little different every time
      const into = res.edges[edges[edges.length - 1]]
      const netMs = into ? (into.rttMs + into.transferMs) * (0.9 + 0.2 * rand()) : 0
      if (!geoAllows(cur, regionOf(origin))) {
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: n.latency * 0.5, netMs, outcome: 'blocked', note: `blocked by geo rule: ${describeGeo(cur)?.toLowerCase()}` })
        const total = timeOf(hops)
        return { id, type, hops, edges, outcome: 'blocked', failedAt: cur.id, totalMs: total, netMs: netOf(hops), summary: `Blocked at ${cur.name}: traffic from ${REGIONS[regionOf(origin)].label} is not allowed through.` }
      }
      // while a database's primary is down and a replica is being promoted, writes fail and reads carry on
      const failover = cur.kind === 'database' && n.failover?.phase === 'failing'
      const isWrite = type === 'write' || type === 'upload'
      const readP = configValue('client', origin.config, 'readPct') ?? 0.9
      let dropP = n.down ? 1 : n.offered > 0 ? n.dropped / n.offered : 0
      if (failover && !n.down && type !== 'any') dropP = isWrite ? 1 : n.offered > 0 ? Math.min(1, Math.max(0, (n.dropped - (1 - readP) * n.offered) / Math.max(1e-9, readP * n.offered))) : 0
      if (rand() < dropP) {
        const why = failover && isWrite ? 'the primary is down while a replica is promoted, so writes fail' : whyDropped(n, cur.kind)
        const wait = Math.min(5000, n.latency)
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: wait, netMs, outcome: 'dropped', note: `rejected: ${why}` })
        const total = timeOf(hops)
        return { id, type, hops, edges, outcome: 'dropped', failedAt: cur.id, totalMs: total, netMs: netOf(hops), summary: `Failed at ${cur.name}: ${why}.` }
      }
      const rho = Math.min(Math.max(n.util, 0), 1.2)
      let ms = n.latency * (0.8 + 0.6 * rand())
      let note = 'served'
      if (cur.kind === 'serverless' && rand() < (n.cold ?? 0)) { ms += FUNCTION_COLD_START_MS; note = 'cold start: a new instance had to start' }
      else if (rand() < 0.03) { ms *= 2 + 6 * rho * rho; note = 'served, but this one was an unlucky slow request' }
      const bypass = (type === 'write' || type === 'upload') && (cur.kind === 'cache' || cur.kind === 'cdn')
      if ((cur.kind === 'cache' || cur.kind === 'cdn') && !bypass && rand() < (type === 'read' ? (n.readHit ?? n.hit) : n.hit)) {
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms, netMs, outcome: 'hit', note: cur.kind === 'cdn' ? 'CDN hit: answered from the edge' : 'cache hit: answered from memory' })
        const total = timeOf(hops)
        return { id, type, hops, edges, outcome: 'ok', failedAt: null, totalMs: total, netMs: netOf(hops), summary: `Served by ${cur.name} without reaching what is behind it.` }
      }
      if (bypass) note = `${type}: not cacheable, goes straight to the origin`
      else if (cur.kind === 'cache' || cur.kind === 'cdn') note = 'miss: passed on to the origin'
      else if (cur.kind === 'database' && type !== 'any') {
        if (type === 'read' && (n.staleReads ?? 0) > 0 && rand() < (n.staleReads ?? 0)) note = `read from a replica ${Math.round(n.lagMs ?? 0)} ms behind: may be stale`
        else if (type === 'read') note = 'read served'
        else if ((configValue('database', cur.config, 'consistency') ?? 0) >= 0.5) { ms += n.lagMs ?? 0; note = 'write waits for a replica to confirm it (strong consistency)' }
        else note = 'write committed on the primary'
      }
      hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms, netMs, outcome: 'ok', note })
    }
    let next = out.get(cur.id)
    if (type === 'upload' && next?.length) { const toward = next.filter((x) => toStore.has(x.to)); if (toward.length) next = toward }
    if (!next?.length) {
      const total = timeOf(hops)
      return { id, type, hops, edges, outcome: 'ok', failedAt: null, totalMs: total, netMs: netOf(hops), summary: `Completed at ${cur.name}.` }
    }
    // follow the traffic: where this client's requests actually go (matters for a balancer that is not splitting evenly)
    const w = next.map((x) => { const r = res.edges[x.id]; return Math.max(0, r?.lb?.bySource[origin.id] ?? r?.rps ?? 0) })
    const wt = w.reduce((a, b) => a + b, 0)
    let pickE = Math.min(next.length - 1, Math.floor(rand() * next.length))
    if (wt > 0) { let r = rand() * wt; for (let i = 0; i < next.length; i++) { r -= w[i]; if (r <= 0) { pickE = i; break } } }
    const e = next[pickE]
    edges.push(e.id)
    const nxt = byId.get(e.to)
    if (!nxt) return null
    cur = nxt
  }
  return null
}

/**
 * Sample a trace. With `via`, keeps drawing until the request travels over that connection (used when the
 * user clicks a moving dot on it), falling back to an ordinary trace if the connection carries no traffic.
 */
export function sampleTrace(arch: Architecture, res: StepResult, seed: number, via?: string, from?: string, type: TraceType = 'any'): Trace | null {
  let first: Trace | null = null
  for (let attempt = 0; attempt < (via ? 300 : 1); attempt++) {
    const t = walk(arch, res, rng(seed + attempt * 7919), seed, from, type)
    if (!t) continue
    first ??= t
    if (!via || t.edges.includes(via)) return t
  }
  return first
}

export type TraceOutcomeFilter = 'any' | 'ok' | 'fail' | 'slow'
export interface TraceOptions {
  /** Id of the client the request starts from. Unset = any client, weighted by its traffic. */
  from?: string
  outcome: TraceOutcomeFilter
  type: TraceType
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0)
const PROBE = 300
const MAX_TRIES = 400

/**
 * Sample one trace that matches the filter by drawing until one does ("fail" = dropped; "slow" = a successful
 * request slower than the 95th percentile of ordinary ones). `matched` is false when none turned up in a
 * reasonable number of draws, in which case an ordinary trace comes back so there is still something to show.
 */
export function findTrace(arch: Architecture, res: StepResult, seed: number, opts: TraceOptions, via?: string): { trace: Trace | null; matched: boolean } {
  if (opts.outcome === 'any') return { trace: sampleTrace(arch, res, seed, via, opts.from, opts.type), matched: true }
  let slowMs = Infinity
  if (opts.outcome === 'slow') {
    const ms: number[] = []
    for (let i = 0; i < PROBE; i++) { const t = walk(arch, res, rng(seed + (i + 1) * 104729), seed, opts.from, opts.type); if (t?.outcome === 'ok') ms.push(t.totalMs) }
    slowMs = quantile(ms.sort((a, b) => a - b), 0.95)
  }
  for (let i = 0; i < MAX_TRIES; i++) {
    const t = walk(arch, res, rng(seed + i * 7919), seed, opts.from, opts.type)
    if (!t) continue
    if (via && !t.edges.includes(via)) continue
    const ok = opts.outcome === 'ok' ? t.outcome === 'ok'
      : opts.outcome === 'fail' ? t.outcome === 'dropped'
      : t.outcome === 'ok' && t.totalMs >= slowMs
    if (ok) return { trace: t, matched: true }
  }
  return { trace: sampleTrace(arch, res, seed, via, opts.from, opts.type), matched: false }
}

export interface TraceSummary {
  type: TraceType
  n: number
  ok: number
  dropped: number
  blocked: number
  /** Latency of the requests that completed. */
  p50: number
  p99: number
  /** Where failed requests ended, most common first. */
  failures: { nodeId: string; name: string; count: number }[]
}

/** Trace many requests and summarise them. */
export function sampleTraces(arch: Architecture, res: StepResult, seed: number, n: number, from?: string, type: TraceType = 'any'): TraceSummary | null {
  const okMs: number[] = []
  const fails = new Map<string, { name: string; count: number }>()
  let ok = 0, dropped = 0, blocked = 0, total = 0
  for (let i = 0; i < n; i++) {
    const t = walk(arch, res, rng(seed + i * 7919), seed + i, from, type)
    if (!t) continue
    total++
    if (t.outcome === 'ok') { ok++; okMs.push(t.totalMs) }
    else if (t.outcome === 'blocked') blocked++
    else {
      dropped++
      const h = t.hops[t.hops.length - 1]
      const f = fails.get(h.nodeId) ?? { name: h.name, count: 0 }
      f.count++
      fails.set(h.nodeId, f)
    }
  }
  if (!total) return null
  okMs.sort((a, b) => a - b)
  return {
    type, n: total, ok, dropped, blocked,
    p50: quantile(okMs, 0.5), p99: quantile(okMs, 0.99),
    failures: [...fails].map(([nodeId, f]) => ({ nodeId, ...f })).sort((a, b) => b.count - a.count),
  }
}
