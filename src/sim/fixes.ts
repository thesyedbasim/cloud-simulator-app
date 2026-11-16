/**
 * Suggested fixes are found by experiment, not by rule of thumb: generate candidate changes, re-run the
 * stress suite on each, and keep the ones that measurably help. Cheap because the engine is tiny.
 */
import type { Architecture, ArchComponent } from '../store/types'
import { scaleSpec, appCapacityPerInstance, hourlyCost } from './capacity'
import { runSuite, type Suite } from './headless'
import { addParallelCopy, insertCacheBefore } from './review'

export interface Suggestion {
  id: string
  title: string
  detail: string
  arch: Architecture
  before: Suite
  after: Suite
  /** Change in total estimated $/hour. */
  costDelta: number
}

interface Candidate {
  id: string
  title: string
  detail: string
  arch: Architecture
  /** Component this change is about; two changes are only combined when their targets differ. */
  target: string
  /** Config change (independent of other components) or a structural edit, so changes can be combined. */
  patch?: { id: string; values: Record<string, number> }
  struct?: (a: Architecture) => Architecture | null
}

const withConfig = (arch: Architecture, id: string, patch: Record<string, number>): Architecture => ({
  ...arch,
  components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...patch }, assumed: c.assumed?.filter((k) => !(k in patch)) } : c)),
})

const cfgCandidate = (arch: Architecture, id: string, key: string, title: string, detail: string, values: Record<string, number>): Candidate => ({
  id: `${id}:${key}`, title, detail, target: id, patch: { id, values }, arch: withConfig(arch, id, values),
})

function candidates(arch: Architecture): Candidate[] {
  const out: Candidate[] = []
  const hasQueue = arch.components.some((c) => c.kind === 'queue')
  const hasCacheBefore = (db: ArchComponent) => arch.connections.some((e) => e.to === db.id && arch.components.find((c) => c.id === e.from)?.kind === 'cache')
  for (const c of arch.components) {
    const cfg = c.config
    switch (c.kind) {
      case 'appServers': {
        const n = cfg.instances ?? 1
        for (const add of [1, 2]) {
          if (n + add <= 20) out.push(cfgCandidate(arch, c.id, `out${add}`, `Add ${add === 1 ? 'an instance' : `${add} instances`} to ${c.name}`, `Scale out from ${n} to ${n + add} instances. Spreads load and survives losing one.`, { instances: n + add }))
        }
        if ((cfg.autoscale ?? 0) < 0.5) {
          const max = Math.min(20, Math.max(8, n * 3))
          out.push(cfgCandidate(arch, c.id, 'auto', `Turn on autoscaling for ${c.name}`, `Adds instances when load is high (up to ${max}), after a start-up delay. Cheaper than always running the maximum.`, { autoscale: 1, maxInstances: max }))
        } else if ((cfg.maxInstances ?? 8) < 20) {
          const m = cfg.maxInstances ?? 8
          out.push(cfgCandidate(arch, c.id, 'max', `Raise ${c.name}'s autoscaling maximum`, `Allow up to ${Math.min(20, m * 2)} instances instead of ${m}.`, { maxInstances: Math.min(20, m * 2) }))
        }
        const up = scaleSpec(cfg, 1)
        if (up) out.push(cfgCandidate(arch, c.id, 'up', `Scale up ${c.name}`, `${cfg.vcpu} vCPU / ${cfg.ramGb} GB → ${up.vcpu} vCPU / ${up.ramGb} GB per instance (${appCapacityPerInstance(cfg).rps} → ${appCapacityPerInstance({ ...cfg, ...up }).rps} rps each).`, up))
        break
      }
      case 'database': {
        const up = scaleSpec(cfg, 1)
        if (up) out.push(cfgCandidate(arch, c.id, 'up', `Scale up ${c.name}`, `${cfg.vcpu} vCPU / ${cfg.ramGb} GB → ${up.vcpu} vCPU / ${up.ramGb} GB.`, up))
        const pool = cfg.poolSize ?? 20
        if (pool * 2 <= 200) out.push(cfgCandidate(arch, c.id, 'pool', `Double ${c.name}'s connection pool`, `Pool ${pool} → ${pool * 2}. Helps only while connections are the bottleneck.`, { poolSize: pool * 2 }))
        // a cache helps reads; a design with a queue is a write path, so don't suggest one there
        if (!hasQueue && !hasCacheBefore(c)) {
          const withCache = insertCacheBefore(arch, c.id)
          if (withCache) out.push({ id: `${c.id}:cache`, title: `Put a cache in front of ${c.name}`, detail: 'Most reads are served from memory, so far fewer reach the database.', arch: withCache, target: c.id, struct: (a) => insertCacheBefore(a, c.id) })
        }
        break
      }
      case 'cache': {
        const h = cfg.hitRate ?? 0.8
        if (h < 0.95) out.push(cfgCandidate(arch, c.id, 'hit', `Enlarge ${c.name}`, `A bigger cache raises the hit rate ${Math.round(h * 100)}% → ${Math.min(98, Math.round((h + 0.1) * 100))}%, shielding what is behind it.`, { hitRate: Math.min(0.98, h + 0.1) }))
        break
      }
      case 'queue': {
        const d = cfg.capacity ?? 400
        out.push(cfgCandidate(arch, c.id, 'drain', `Drain ${c.name} faster`, `Drain rate ${d} → ${d * 2} msg/s.`, { capacity: d * 2 }))
        const m = cfg.maxDepth ?? 2000
        if (m * 2 <= 10000) out.push(cfgCandidate(arch, c.id, 'depth', `Deepen ${c.name}`, `Max depth ${m} → ${m * 2}. Buys time but does not raise throughput.`, { maxDepth: m * 2 }))
        break
      }
      default: break
    }
  }
  return out
}

const totalCost = (arch: Architecture) => arch.components.reduce((a, c) => a + hourlyCost(c.kind, c.config), 0)

const MIN_GAIN = 0.02

/**
 * Up to `limit` changes that measurably improve the stress-suite result, best first. If no single change
 * gets every scenario through, pairs of changes on different components are tried too (a slow queue and
 * too few workers, say, only help together).
 */
export function suggestFixes(arch: Architecture, limit = 5): { before: Suite; fixes: Suggestion[] } {
  const before = runSuite(arch)
  if (!before.failing.length) return { before, fixes: [] }
  const cands = candidates(arch)
  const make = (c: { id: string; title: string; detail: string; arch: Architecture }, after: Suite): Suggestion => ({
    id: c.id, title: c.title, detail: c.detail, arch: c.arch, before, after, costDelta: totalCost(c.arch) - totalCost(arch),
  })

  const singles: { c: Candidate; after: Suite }[] = []
  for (const c of cands) {
    const after = runSuite(c.arch)
    if (before.score - after.score >= MIN_GAIN) singles.push({ c, after })
  }
  const fixes: Suggestion[] = singles.map(({ c, after }) => make(c, after))

  // nothing gets everything through on its own: try pairs on different components
  if (!singles.some((s) => s.after.failing.length === 0)) {
    const best = Math.min(...singles.map((s) => s.after.failing.length), before.failing.length)
    const bestScore = Math.min(...singles.map((s) => s.after.score), before.score)
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i], b = cands[j]
        if (a.target === b.target) continue
        const next = b.patch ? withConfig(a.arch, b.patch.id, b.patch.values) : b.struct ? b.struct(a.arch) : null
        if (!next) continue
        const after = runSuite(next)
        if (after.failing.length < best || after.score < bestScore - 0.05) {
          fixes.push(make({ id: `${a.id}+${b.id}`, title: `${a.title}, and ${b.title.charAt(0).toLowerCase()}${b.title.slice(1)}`, detail: `${a.detail} ${b.detail}`, arch: next }, after))
        }
      }
    }
  }

  // fixes more scenarios first, then the bigger improvement, then the cheaper one
  fixes.sort((a, b) => a.after.failing.length - b.after.failing.length || a.after.score - b.after.score || a.costDelta - b.costDelta)
  return { before, fixes: fixes.slice(0, limit) }
}

export { addParallelCopy }
