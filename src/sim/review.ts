/** Static design review: no simulation needed. Single points of failure, and a readable diff between two designs. */
import { CONFIG_SCHEMA, KIND_INFO, type ArchComponent, type Architecture } from '../store/types'
import { findFreeCell } from '../store/arch'

export interface Spof { id: string; name: string; reason: string }

/**
 * A component is a single point of failure when every request path from a client to the end of the
 * chain goes through it and it has no redundancy (a scaled-out app tier counts as redundant).
 * Redundancy for the other kinds means a parallel copy, since the model has no replicas.
 */
export function findSpofs(arch: Architecture): Spof[] {
  const out = new Map<string, string[]>()
  for (const e of arch.connections) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const clients = arch.components.filter((c) => c.kind === 'client' && out.has(c.id)).map((c) => c.id)
  const terminals = new Set(arch.components.filter((c) => c.kind !== 'client' && !out.has(c.id)).map((c) => c.id))
  if (!clients.length || !terminals.size) return []

  const reachesEnd = (without: string) => {
    const seen = new Set<string>(clients)
    const q = [...clients]
    while (q.length) {
      const id = q.shift()!
      for (const n of out.get(id) ?? []) {
        if (n === without || seen.has(n)) continue
        seen.add(n)
        q.push(n)
      }
    }
    return [...terminals].some((t) => t !== without && seen.has(t))
  }

  const spofs: Spof[] = []
  for (const c of arch.components) {
    if (c.kind === 'client' || reachesEnd(c.id)) continue
    if (c.kind === 'appServers') {
      const n = c.config.instances ?? 1
      if (n > 1) continue
      spofs.push({ id: c.id, name: c.name, reason: 'Every request goes through it and it has a single instance. If that instance fails, the whole path is down.' })
    } else {
      spofs.push({ id: c.id, name: c.name, reason: `Every request goes through it and nothing runs in parallel. If it fails, the whole path is down.` })
    }
  }
  return spofs
}

// ---------- structural edits used by the fix search ----------

const nextName = (arch: Architecture, c: ArchComponent) => `${KIND_INFO[c.kind].label} ${arch.components.filter((x) => x.kind === c.kind).length + 1}`

function uniqueId(arch: Architecture, base: string) {
  let n = 2
  while (arch.components.some((c) => c.id === `${base}-${n}`) || arch.connections.some((e) => e.id.startsWith(`${base}-${n}`))) n++
  return `${base}-${n}`
}

/** Clone a component and wire it in parallel: same inputs, same outputs. */
export function addParallelCopy(arch: Architecture, id: string): Architecture | null {
  const src = arch.components.find((c) => c.id === id)
  if (!src) return null
  const spot = findFreeCell(arch, src.position.col, src.position.row + 3) ?? findFreeCell(arch, src.position.col + 3, src.position.row)
  if (!spot) return null
  const copyId = uniqueId(arch, src.id)
  const copy: ArchComponent = { ...src, id: copyId, name: nextName(arch, src), position: spot, config: { ...src.config }, assumed: src.assumed ? [...src.assumed] : undefined }
  const edges = arch.connections.flatMap((e) =>
    e.to === id ? [{ id: `${copyId}-in-${e.id}`, from: e.from, to: copyId }] : e.from === id ? [{ id: `${copyId}-out-${e.id}`, from: copyId, to: e.to }] : [],
  )
  return { ...arch, components: [...arch.components, copy], connections: [...arch.connections, ...edges] }
}

/** Put a cache between a database and whatever calls it. */
export function insertCacheBefore(arch: Architecture, dbId: string): Architecture | null {
  const db = arch.components.find((c) => c.id === dbId)
  if (!db) return null
  const incoming = arch.connections.filter((e) => e.to === dbId)
  if (!incoming.length) return null
  const spot = findFreeCell(arch, db.position.col, db.position.row - 3) ?? findFreeCell(arch, db.position.col - 3, db.position.row)
  if (!spot) return null
  const id = uniqueId(arch, 'cache')
  const cache: ArchComponent = { id, kind: 'cache', name: nextName(arch, { ...db, kind: 'cache' }), position: spot, config: { hitRate: 0.8 }, assumed: ['hitRate'] }
  const drop = new Set(incoming.map((e) => e.id))
  const rewired = incoming.map((e) => ({ id: `${id}-in-${e.id}`, from: e.from, to: id }))
  return {
    ...arch,
    components: [...arch.components, cache],
    connections: [...arch.connections.filter((e) => !drop.has(e.id)), ...rewired, { id: `${id}-out`, from: id, to: dbId }],
  }
}

// ---------- diff ----------

export interface Change { kind: 'added' | 'removed' | 'changed'; text: string }

const fmtVal = (kind: ArchComponent['kind'], key: string, v: number) => {
  const f = CONFIG_SCHEMA[kind].find((x) => x.key === key)
  return f?.pct ? `${Math.round(v * 100)}%` : `${v}${f?.unit ? ` ${f.unit}` : ''}`
}

/** What changed going from design a to design b, in plain words. */
export function diffArch(a: Architecture, b: Architecture): Change[] {
  const out: Change[] = []
  const am = new Map(a.components.map((c) => [c.id, c]))
  const bm = new Map(b.components.map((c) => [c.id, c]))
  for (const c of b.components) if (!am.has(c.id)) out.push({ kind: 'added', text: `Added ${c.name}` })
  for (const c of a.components) if (!bm.has(c.id)) out.push({ kind: 'removed', text: `Removed ${c.name}` })
  for (const c of b.components) {
    const p = am.get(c.id)
    if (!p) continue
    for (const f of CONFIG_SCHEMA[c.kind]) {
      const x = p.config[f.key], y = c.config[f.key]
      if (x !== y && x !== undefined && y !== undefined) out.push({ kind: 'changed', text: `${c.name}: ${f.label} ${fmtVal(c.kind, f.key, x)} → ${fmtVal(c.kind, f.key, y)}` })
    }
  }
  const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`
  const as = new Set(a.connections.map(key)), bs = new Set(b.connections.map(key))
  const name = (id: string) => bm.get(id)?.name ?? am.get(id)?.name ?? id
  const added = b.connections.filter((e) => !as.has(key(e))).length
  const removed = a.connections.filter((e) => !bs.has(key(e))).length
  if (added || removed) out.push({ kind: 'changed', text: `Connections: ${added ? `+${added}` : ''}${added && removed ? ' ' : ''}${removed ? `−${removed}` : ''}` })
  void name
  return out
}
