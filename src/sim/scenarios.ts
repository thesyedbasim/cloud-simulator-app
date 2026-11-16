import type { Architecture } from '../store/types'
import type { Injected, TrafficShape } from './engine'

export type ScenarioId = 'spike' | 'nodeFailure' | 'slowDb'

export const SCENARIOS: { id: ScenarioId; label: string; blurb: string }[] = [
  { id: 'spike', label: 'Traffic spike', blurb: 'Load triples for about 20 s' },
  { id: 'nodeFailure', label: 'Node failure', blurb: 'One app instance dies mid-traffic' },
  { id: 'slowDb', label: 'Slow database', blurb: 'Queries become 4× slower' },
]

export interface ScenarioPlan {
  id: ScenarioId
  label: string
  /** Traffic shape to switch to (restored when the scenario stops). */
  shape?: TrafficShape
  /** Faults to inject, keyed by component id. */
  injections: Record<string, Injected>
  /** Sim seconds after the start at which the fault lands (baseline traffic runs first). */
  at: number
  summary: string
  /** Set when the architecture has nothing this scenario can act on. */
  empty?: string
}

/** Pure: decides what a scenario does to the given architecture. */
export function planScenario(arch: Architecture, id: ScenarioId): ScenarioPlan {
  const label = SCENARIOS.find((s) => s.id === id)!.label
  const comps = arch.components
  switch (id) {
    case 'spike':
      return { id, label, shape: 'spike', injections: {}, at: 0, summary: 'Traffic ramps to 3× after about 10 s.' }
    case 'nodeFailure': {
      const target = comps.find((c) => c.kind === 'appServers') ?? comps.find((c) => c.kind !== 'client' && c.kind !== 'loadBalancer')
      if (!target) return { id, label, injections: {}, at: 5, summary: '', empty: 'Add an App Servers (or any non-client) component first.' }
      return { id, label, injections: { [target.id]: 'lostInstance' }, at: 5, summary: `One instance of ${target.name} fails after 5 s.` }
    }
    case 'slowDb': {
      const dbs = comps.filter((c) => c.kind === 'database')
      if (!dbs.length) return { id, label, injections: {}, at: 5, summary: '', empty: 'Add a Database first.' }
      return { id, label, injections: Object.fromEntries(dbs.map((d) => [d.id, 'slow' as const])), at: 5, summary: `${dbs.map((d) => d.name).join(', ')} slows down after 5 s.` }
    }
  }
}
