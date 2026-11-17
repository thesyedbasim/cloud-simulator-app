/**
 * Chaos experiments: faults scheduled on a timeline. Pure functions, no UI. An experiment is saved with the design,
 * so it can be replayed against it (or against a changed version of it) and the results compared.
 */
import type { Architecture, ChaosEvent, ComponentKind, Experiment, FaultKind } from '../store/types'
import type { Injected, TrafficShape } from './engine'
import { SHAPES } from './engine'

export const MAX_EXPERIMENTS = 20
export const MAX_EVENTS = 30
export const MAX_TIME = 300

export const FAULT_LABEL: Record<FaultKind, string> = {
  killed: 'Kill',
  slow: 'Slow down (4×)',
  lostInstance: 'Lose one instance',
  flushed: 'Flush',
  zoneLoss: 'Lose a zone',
  bad: 'Bad release',
  hotKey: 'Hot key',
  flood: 'Flood (8×)',
}

/** The faults that make sense for a kind of component, in the order the editor offers them. */
export function faultsFor(kind: ComponentKind): FaultKind[] {
  switch (kind) {
    case 'client': return ['flood']
    case 'appServers': return ['killed', 'slow', 'lostInstance', 'zoneLoss', 'bad']
    case 'serverless': return ['killed', 'slow', 'bad']
    case 'database': return ['killed', 'slow', 'hotKey']
    case 'cache':
    case 'cdn': return ['killed', 'slow', 'flushed']
    case 'queue': return ['killed', 'slow', 'hotKey']
    default: return ['killed', 'slow']
  }
}

/** The faults in force at time `t`: events are applied in time order (ties in list order), and a restore lifts whatever the target had. */
export function faultsAt(events: ChaosEvent[], t: number): Record<string, Injected> {
  const out: Record<string, Injected> = {}
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i)
  for (const { e } of ordered) {
    if (e.at > t + 1e-9) break
    if (e.action === 'restore') delete out[e.target]
    else out[e.target] = e.action
  }
  return out
}

/** How long to run an experiment for: until 30 s after the last event, and never under a minute. */
export const experimentSeconds = (exp: Pick<Experiment, 'events'>) => Math.min(MAX_TIME + 60, Math.max(60, Math.ceil(Math.max(0, ...exp.events.map((e) => e.at)) + 30)))

/** Plain-language lines for an experiment, e.g. "at 10 s: Kill App Servers". */
export function describeExperiment(exp: Experiment, arch: Architecture): string[] {
  const name = (id: string) => arch.components.find((c) => c.id === id)?.name ?? 'a component that no longer exists'
  return [...exp.events].sort((a, b) => a.at - b.at).map((e) => `at ${e.at} s: ${e.action === 'restore' ? 'restore' : FAULT_LABEL[e.action]} ${name(e.target)}`)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const FAULTS = new Set<string>(Object.keys(FAULT_LABEL))

/**
 * Cleans experiments that come from outside (a file, browser storage): drops events that point at a missing component or
 * use an unknown fault, clamps times, caps sizes, and gives every experiment a unique id. Never throws.
 */
export function sanitizeExperiments(raw: unknown, componentIds: Set<string>): { experiments: Experiment[]; warnings: string[] } {
  const warnings: string[] = []
  const experiments: Experiment[] = []
  if (!Array.isArray(raw)) return { experiments, warnings }
  const seen = new Set<string>()
  for (const x of raw.slice(0, MAX_EXPERIMENTS)) {
    if (!isObj(x) || typeof x.id !== 'string' || !x.id || seen.has(x.id) || !Array.isArray(x.events)) { warnings.push('Skipped a chaos experiment that was invalid or duplicated.'); continue }
    const events: ChaosEvent[] = []
    for (const e of x.events.slice(0, MAX_EVENTS)) {
      const at = isObj(e) ? Number(e.at) : NaN
      if (!isObj(e) || !Number.isFinite(at) || typeof e.target !== 'string' || !componentIds.has(e.target) || typeof e.action !== 'string' || !(e.action === 'restore' || FAULTS.has(e.action))) { warnings.push('Skipped a chaos event that pointed at a missing component or an unknown fault.'); continue }
      events.push({ at: Math.min(MAX_TIME, Math.max(0, Math.round(at * 10) / 10)), target: e.target, action: e.action as ChaosEvent['action'] })
    }
    const shape = SHAPES.some((s) => s.id === x.shape) ? (x.shape as TrafficShape) : undefined
    seen.add(x.id)
    experiments.push({ id: x.id, name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 60) : 'Experiment', events, ...(shape ? { shape } : {}) })
  }
  if (Array.isArray(raw) && raw.length > MAX_EXPERIMENTS) warnings.push(`Kept the first ${MAX_EXPERIMENTS} chaos experiments.`)
  return { experiments, warnings }
}
