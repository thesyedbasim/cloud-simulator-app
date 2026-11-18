import type { Trigger } from '../sim/triggers'
/**
 * Project files: save, load, export, import. Everything that comes from outside (a saved copy in the
 * browser, a file the user picks) goes through parseProject, which validates and sanitises it, so a corrupt
 * or hand-edited file can never put the app into a broken state.
 */
import { BLANK } from '../presets/index'
import { linkShortener } from '../presets/linkShortener'
import { CONFIG_SCHEMA, DEFAULT_CONFIG, KIND_INFO, type ArchComponent, type Architecture, type ComponentKind } from './types'
import { BOUND } from './arch'
import { CONN_FIELDS, type ConnKey } from '../sim/balance'
import { sanitizeExperiments } from '../sim/chaos'

export const PROJECT_VERSION = 1
export const STORAGE_KEY = 'cloudsim:project:v1'
const MAX_COMPONENTS = 60
const MAX_CONNECTIONS = 200

export interface ProjectFile { app: 'cloudsim'; version: number; savedAt: string; architecture: Architecture }
export type ParseResult = { ok: true; arch: Architecture; warnings: string[] } | { ok: false; error: string }

export function serializeProject(arch: Architecture): string {
  const file: ProjectFile = { app: 'cloudsim', version: PROJECT_VERSION, savedAt: new Date().toISOString(), architecture: arch }
  return JSON.stringify(file, null, 2)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isKind = (v: unknown): v is ComponentKind => typeof v === 'string' && v in KIND_INFO

const num = <K extends string>(v: unknown, lo: number, hi: number, key: K): Partial<Record<K, number>> => (v !== undefined && Number.isFinite(Number(v)) ? ({ [key]: Math.min(hi, Math.max(lo, Number(v))) } as Record<K, number>) : {})
function cleanTriggers(v: unknown): Trigger[] {
  if (!Array.isArray(v)) return []
  const out: Trigger[] = []
  for (const t of v.slice(0, 8)) {
    if (!isObj(t) || typeof t.id !== 'string' || !t.id || out.some((x) => x.id === t.id) || (t.kind !== 'schedule' && t.kind !== 'event')) continue
    out.push({ id: t.id, kind: t.kind, ...num(t.everySec, 0.1, 86400, 'everySec'), ...num(t.batch, 1, 10000, 'batch'), ...num(t.ratio, 0, 100, 'ratio'), ...num(t.readPct, 0, 1, 'readPct'), ...(typeof t.source === 'string' ? { source: t.source } : {}), ...(typeof t.app === 'string' ? { app: t.app } : {}) })
  }
  return out
}
function cleanApps(v: unknown): { id: string; name: string; targets: string[] }[] {
  if (!Array.isArray(v)) return []
  const out: { id: string; name: string; targets: string[] }[] = []
  for (const a of v.slice(0, 12)) {
    if (!isObj(a) || typeof a.id !== 'string' || !a.id || out.some((x) => x.id === a.id)) continue
    out.push({ id: a.id, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 40) : 'Application', targets: Array.isArray(a.targets) ? a.targets.filter((t): t is string => typeof t === 'string').slice(0, 20) : [], ...num(a.readPct, 0, 1, 'readPct'), ...num(a.payloadKb, 1, 1000, 'payloadKb'), ...num(a.weight, 1, 5, 'weight'), ...num(a.runMs, 1, 60000, 'runMs'), ...num(a.memoryMb, 1, 10240, 'memoryMb'), ...num(a.cores, 0.01, 6, 'cores') })
  }
  return out
}
function cleanMix(v: unknown): Record<string, number> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, x] of Object.entries(v)) { const n = Number(x); if (Number.isFinite(n)) out[k] = Math.min(100, Math.max(0, n)) }
  return Object.keys(out).length ? out : undefined
}

export function parseProject(text: string): ParseResult {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, error: "That file isn't valid JSON." } }
  if (!isObj(raw) || raw.app !== 'cloudsim') return { ok: false, error: "That doesn't look like a CloudSim project file." }
  if (typeof raw.version !== 'number' || raw.version > PROJECT_VERSION) return { ok: false, error: 'This file was made by a newer version of CloudSim.' }
  const a = raw.architecture
  if (!isObj(a) || !Array.isArray(a.components) || !Array.isArray(a.connections)) return { ok: false, error: 'The project has no architecture in it.' }
  if (a.components.length > MAX_COMPONENTS) return { ok: false, error: `Too many components (the limit is ${MAX_COMPONENTS}).` }
  if (a.connections.length > MAX_CONNECTIONS) return { ok: false, error: `Too many connections (the limit is ${MAX_CONNECTIONS}).` }

  const warnings: string[] = []
  const components: ArchComponent[] = []
  const ids = new Set<string>()
  for (const c of a.components) {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id || !isKind(c.kind) || ids.has(c.id)) { warnings.push('Skipped a component that was invalid or duplicated.'); continue }
    const kind = c.kind
    const pos = isObj(c.position) ? c.position : {}
    const col = Math.round(Number(pos.col)), row = Math.round(Number(pos.row))
    if (!Number.isFinite(col) || !Number.isFinite(row) || Math.abs(col) > BOUND || Math.abs(row) > BOUND) { warnings.push(`Skipped "${String(c.name ?? c.id)}": it sits outside the canvas.`); continue }
    const given = isObj(c.config) ? c.config : {}
    const config: Record<string, number> = {}
    for (const f of CONFIG_SCHEMA[kind]) {
      if (f.optional && given[f.key] === undefined) continue // absent in older files; the default applies
      const v = Number(given[f.key])
      config[f.key] = Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, v)) : DEFAULT_CONFIG[kind][f.key]
    }
    const assumed = Array.isArray(c.assumed) ? c.assumed.filter((k): k is string => typeof k === 'string' && k in config) : undefined
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 40) : KIND_INFO[kind].label
    ids.add(c.id)
    const apps = kind === 'appServers' || kind === 'serverless' ? cleanApps(c.apps) : undefined
    const triggers = kind === 'serverless' ? cleanTriggers(c.triggers) : undefined
    const mix = kind === 'client' ? cleanMix(c.mix) : undefined
    components.push({ id: c.id, kind, name, position: { col, row }, config, assumed, ...(apps?.length ? { apps } : {}), ...(mix ? { mix } : {}), ...(triggers?.length ? { triggers } : {}) })
  }
  // overlapping components would be unclickable: refuse rather than silently stacking them
  for (let i = 0; i < components.length; i++) for (let j = i + 1; j < components.length; j++) {
    const p = components[i].position, q = components[j].position
    if (Math.abs(p.col - q.col) < 2 && Math.abs(p.row - q.row) < 2) return { ok: false, error: `"${components[i].name}" and "${components[j].name}" overlap on the canvas.` }
  }

  const connections: Architecture['connections'] = []
  const seen = new Set<string>()
  for (const e of a.connections) {
    if (!isObj(e) || typeof e.id !== 'string' || typeof e.from !== 'string' || typeof e.to !== 'string' || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) { warnings.push('Skipped a connection that pointed at a missing component.'); continue }
    const key = `${e.from}>${e.to}`
    if (seen.has(key) || seen.has(`${e.to}>${e.from}`)) { warnings.push('Skipped a duplicate connection.'); continue }
    seen.add(key)
    const cfg: Record<string, number> = {}
    if (isObj(e.config)) for (const k of Object.keys(CONN_FIELDS) as ConnKey[]) { const v = Number(e.config[k]); if (e.config[k] !== undefined && Number.isFinite(v)) cfg[k] = Math.min(CONN_FIELDS[k].max, Math.max(CONN_FIELDS[k].min, v)) }
    connections.push({ id: e.id, from: e.from, to: e.to, ...(Object.keys(cfg).length ? { config: cfg } : {}) })
  }
  const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : 'Imported design'
  // optional service-level targets: keep them if sensible, clamp them into range
  let slo: Architecture['slo']
  if (isObj(a.slo)) {
    const av = Number(a.slo.availability), p99 = Number(a.slo.p99Ms)
    if (Number.isFinite(av) && Number.isFinite(p99)) slo = { availability: Math.min(0.99999, Math.max(0.9, av)), p99Ms: Math.min(10000, Math.max(20, p99)) }
  }
  // saved chaos experiments: keep the ones that still make sense for this design
  const exp = sanitizeExperiments(a.experiments, ids)
  warnings.push(...exp.warnings)
  // measured numbers: keep the sensible ones, clamped
  let actual: Architecture['actual']
  if (isObj(a.actual)) {
    const pick = (k: string, lo: number, hi: number) => { const v = Number(a.actual && (a.actual as Record<string, unknown>)[k]); return (a.actual as Record<string, unknown>)[k] !== undefined && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined }
    const p99Ms = pick('p99Ms', 1, 60000), errorPct = pick('errorPct', 0, 100), maxRps = pick('maxRps', 1, 1e7)
    if (p99Ms !== undefined || errorPct !== undefined || maxRps !== undefined) actual = { ...(p99Ms !== undefined ? { p99Ms } : {}), ...(errorPct !== undefined ? { errorPct } : {}), ...(maxRps !== undefined ? { maxRps } : {}) }
  }
  return { ok: true, arch: { name, components, connections, ...(slo ? { slo } : {}), ...(exp.experiments.length ? { experiments: exp.experiments } : {}), ...(actual ? { actual } : {}) }, warnings: [...new Set(warnings)] }
}

// ---------- browser storage (every access guarded: it can be blocked, full, or empty) ----------

export function loadSaved(): Architecture | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return null
    const r = parseProject(text)
    return r.ok ? r.arch : null
  } catch { return null }
}

export function saveToStorage(arch: Architecture): boolean {
  try { localStorage.setItem(STORAGE_KEY, serializeProject(arch)); return true } catch { return false }
}

export function clearSaved() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* nothing to do */ }
}

export const initialArchitecture = (): Architecture => loadSaved() ?? linkShortener
export { BLANK }
