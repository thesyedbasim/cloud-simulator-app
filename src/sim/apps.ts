/**
 * Applications: named routes through an app tier. An app server (or serverless function) can say "this application calls the storage bucket
 * and the database", and each client says what share of its requests belong to each application. A request of an application calls every
 * target it lists, so each target sees that application's full traffic. Without applications, a tier splits traffic evenly between its connections.
 */
import type { ArchComponent, Architecture } from '../store/types'

/** `readPct`, `payloadKb` and `weight` describe the requests of this application; absent means the client's own setting applies. */
/** On a serverless function an application also says what one execution needs: `runMs` (time when it has the cores it needs), `memoryMb` and `cores`. */
export interface App { id: string; name: string; targets: string[]; readPct?: number; payloadKb?: number; weight?: number; runMs?: number; memoryMb?: number; cores?: number }

export const canHaveApps = (c: ArchComponent) => c.kind === 'appServers' || c.kind === 'serverless'

/** The applications of a tier. Targets that are no longer connected downstream are ignored. */
export function appsOf(c: ArchComponent, outTargets: string[]): App[] {
  if (!canHaveApps(c) || !c.apps?.length) return []
  return c.apps.map((a) => ({ ...a, targets: a.targets.filter((t) => outTargets.includes(t)) }))
}

/**
 * Share of one source's requests that belong to each application of a tier (sums to 1). A client names a weight per application;
 * weights are normalised over this tier's applications. No weights at all: an even split.
 */
export function appShares(apps: App[], src: ArchComponent | undefined): number[] {
  const mix = src?.kind === 'client' ? src.mix : undefined
  const w = apps.map((a) => Math.max(0, mix?.[a.id] ?? 0))
  const sum = w.reduce((a, b) => a + b, 0)
  return sum > 0 ? w.map((x) => x / sum) : apps.map(() => 1 / apps.length)
}

/** Every application a client's traffic can reach, with the tier that owns it. */
export function reachableApps(arch: Architecture, clientId: string): { app: App; owner: ArchComponent }[] {
  const byId = new Map(arch.components.map((c) => [c.id, c]))
  const seen = new Set<string>([clientId])
  const queue = [clientId]
  const out: { app: App; owner: ArchComponent }[] = []
  while (queue.length) {
    const id = queue.shift()!
    const targets = arch.connections.filter((e) => e.from === id).map((e) => e.to)
    const c = byId.get(id)
    if (c) for (const a of appsOf(c, targets)) out.push({ app: a, owner: c })
    for (const t of targets) if (!seen.has(t)) { seen.add(t); queue.push(t) }
  }
  return out
}

/**
 * A client's request profile (read share, response size, CPU cost) once its applications are taken into account: each tier's applications
 * are averaged by the client's mix, and with several tiers the tiers are averaged. A client that reaches no application keeps its own settings.
 * Returns a copy of the client with those three settings filled in, so everything that reads them needs no change.
 */
export function effectiveClients(arch: Architecture): Map<string, ArchComponent> {
  const out = new Map<string, ArchComponent>()
  for (const c of arch.components) {
    if (c.kind !== 'client') continue
    const reach = reachableApps(arch, c.id)
    if (!reach.length) { out.set(c.id, c); continue }
    const own = { readPct: c.config.readPct ?? 0.9, payloadKb: c.config.payloadKb ?? 4, weight: c.config.weight ?? 1 }
    const tiers = new Map<string, { app: App; owner: ArchComponent }[]>()
    for (const r of reach) tiers.set(r.owner.id, [...(tiers.get(r.owner.id) ?? []), r])
    const acc = { readPct: 0, payloadKb: 0, weight: 0 }
    for (const group of tiers.values()) {
      const sh = appShares(group.map((g) => g.app), c)
      group.forEach((g, i) => { for (const k of ['readPct', 'payloadKb', 'weight'] as const) acc[k] += sh[i] * (g.app[k] ?? own[k]) / tiers.size })
    }
    out.set(c.id, { ...c, config: { ...c.config, ...acc } })
  }
  return out
}
