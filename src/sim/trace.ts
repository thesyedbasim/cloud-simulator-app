/**
 * Request tracing: follow ONE request through the architecture. The path, each hop's latency and whether the
 * request survives are drawn at random from the simulation's current numbers (edge splits, cache hit rate,
 * per-node drop probability and latency), so over many traces the results match the aggregate metrics.
 */
import type { Architecture, ComponentKind } from '../store/types'
import type { NodeResult, StepResult } from './engine'

export interface Hop {
  nodeId: string
  name: string
  kind: ComponentKind
  /** Time spent at this hop. */
  ms: number
  outcome: 'ok' | 'hit' | 'dropped'
  note: string
}

export interface Trace {
  id: number
  hops: Hop[]
  /** edges[i] connects hops[i] to hops[i + 1]. */
  edges: string[]
  outcome: 'ok' | 'dropped'
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

  const hops: Hop[] = []
  const edges: string[] = []
  for (let guard = 0; guard < MAX_HOPS; guard++) {
    const n = res.nodes[cur.id]
    if (!n) return null
    if (cur.kind === 'client') {
      hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms: 0, outcome: 'ok', note: 'sends the request' })
    } else {
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
      if (rand() < 0.03) { ms *= 2 + 6 * rho * rho; note = 'served, but this one was an unlucky slow request' }
      if (cur.kind === 'cache' && rand() < n.hit) {
        hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms, outcome: 'hit', note: 'cache hit: answered from memory' })
        const total = hops.reduce((a, h) => a + h.ms, 0)
        return { id, hops, edges, outcome: 'ok', failedAt: null, totalMs: total, summary: `Served by ${cur.name} without reaching what is behind it.` }
      }
      if (cur.kind === 'cache') note = 'cache miss: passed on'
      hops.push({ nodeId: cur.id, name: cur.name, kind: cur.kind, ms, outcome: 'ok', note })
    }
    const next = out.get(cur.id)
    if (!next?.length) {
      const total = hops.reduce((a, h) => a + h.ms, 0)
      return { id, hops, edges, outcome: 'ok', failedAt: null, totalMs: total, summary: `Completed at ${cur.name}.` }
    }
    const e = next[Math.min(next.length - 1, Math.floor(rand() * next.length))]
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
