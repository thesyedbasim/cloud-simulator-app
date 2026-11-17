/**
 * Request tracing: follow ONE request through the architecture. The path, each hop's latency and whether the
 * request survives are drawn at random from the simulation's current numbers (edge splits, cache hit rate,
 * per-node drop probability and latency), so over many traces the results match the aggregate metrics.
 */
import type { Architecture, ComponentKind } from '../store/types'
import type { NodeResult, StepResult } from './engine'
import { FUNCTION_COLD_START_MS } from './capacity'
import { describeGeo, geoAllows, regionOf, REGIONS } from './geo'

export interface Hop {
  nodeId: string
  name: string
  kind: ComponentKind
  /** Time spent at this hop. */
  ms: number
  outcome: 'ok' | 'hit' | 'dropped' | 'blocked'
  note: string
}

export interface Trace {
  id: number
  hops: Hop[]
  /** edges[i] connects hops[i] to hops[i + 1]. */
  edges: string[]
  /** 'blocked' means a geo rule turned it away on purpose, which is not a failure. */
  outcome: 'ok' | 'dropped' | 'blocked'
  failedAt: string | null
  totalMs: number
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

function walk(arch: Architecture, res: StepResult, rand: () => number, id: number): Trace | null {
  const byId = new Map(arch.components.map((c) => [c.id, c]))
  const out = new Map<string, { id: string; to: string }[]>()
  for (const e of arch.connections) out.set(e.from, [...(out.get(e.from) ?? []), { id: e.id, to: e.to }])

  // start at a client, weighted by how much traffic each sends
  const clients = arch.components.filter((c) => c.kind === 'client' && out.has(c.id))
  if (!clients.length) return null
  const weights = clients.map((c) => Math.max(1, res.nodes[c.id]?.offered ?? 1))
  let pick = rand() * weights.reduce((a, b) => a + b, 0)
  let cur = clients[0]
  for (let i = 0; i < clients.length; i++) { pick -= weights[i]; if (pick <= 0) { cur = clients[i]; break } }

  const origin = cur
  const hops: Hop[] = []
  const edges: string[] = []
  for (let guard = 0; guard < MAX_HOPS; guard++) {
    const n = res.nodes[cur.id]
    if (!n) return null
    if (cur.kind === 'client') {
      hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: 0, outcome: 'ok', note: `sends the request from ${REGIONS[regionOf(cur)].label}` })
    } else {
      if (!geoAllows(cur, regionOf(origin))) {
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: n.latency * 0.5, outcome: 'blocked', note: `blocked by geo rule: ${describeGeo(cur)?.toLowerCase()}` })
        const total = hops.reduce((a, h) => a + h.ms, 0)
        return { id, hops, edges, outcome: 'blocked', failedAt: cur.id, totalMs: total, summary: `Blocked at ${cur.name}: traffic from ${REGIONS[regionOf(origin)].label} is not allowed through.` }
      }
      const dropP = n.down ? 1 : n.offered > 0 ? n.dropped / n.offered : 0
      if (rand() < dropP) {
        const wait = Math.min(5000, n.latency)
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: wait, outcome: 'dropped', note: `rejected: ${whyDropped(n, cur.kind)}` })
        const total = hops.reduce((a, h) => a + h.ms, 0)
        return { id, hops, edges, outcome: 'dropped', failedAt: cur.id, totalMs: total, summary: `Failed at ${cur.name}: ${whyDropped(n, cur.kind)}.` }
      }
      const rho = Math.min(Math.max(n.util, 0), 1.2)
      let ms = n.latency * (0.8 + 0.6 * rand())
      let note = 'served'
      if (cur.kind === 'serverless' && rand() < (n.cold ?? 0)) { ms += FUNCTION_COLD_START_MS; note = 'cold start: a new instance had to start' }
      else if (rand() < 0.03) { ms *= 2 + 6 * rho * rho; note = 'served, but this one was an unlucky slow request' }
      if ((cur.kind === 'cache' || cur.kind === 'cdn') && rand() < n.hit) {
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms, outcome: 'hit', note: cur.kind === 'cdn' ? 'CDN hit: answered from the edge' : 'cache hit: answered from memory' })
        const total = hops.reduce((a, h) => a + h.ms, 0)
        return { id, hops, edges, outcome: 'ok', failedAt: null, totalMs: total, summary: `Served by ${cur.name} without reaching what is behind it.` }
      }
      if (cur.kind === 'cache' || cur.kind === 'cdn') note = 'miss: passed on to the origin'
      hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms, outcome: 'ok', note })
    }
    const next = out.get(cur.id)
    if (!next?.length) {
      const total = hops.reduce((a, h) => a + h.ms, 0)
      return { id, hops, edges, outcome: 'ok', failedAt: null, totalMs: total, summary: `Completed at ${cur.name}.` }
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
export function sampleTrace(arch: Architecture, res: StepResult, seed: number, via?: string): Trace | null {
  let first: Trace | null = null
  for (let attempt = 0; attempt < (via ? 300 : 1); attempt++) {
    const t = walk(arch, res, rng(seed + attempt * 7919), seed)
    if (!t) continue
    first ??= t
    if (!via || t.edges.includes(via)) return t
  }
  return first
}
