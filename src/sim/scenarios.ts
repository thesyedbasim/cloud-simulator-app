import type { Architecture, ArchComponent } from '../store/types'
import type { Injected, TrafficShape } from './engine'

export type ScenarioId = 'spike' | 'nodeFailure' | 'slowDb' | 'cacheFlush' | 'retryStorm' | 'zoneOutage' | 'grayFailure' | 'badDeploy' | 'thunderingHerd' | 'hotPartition' | 'botFlood'

export const SCENARIOS: { id: ScenarioId; label: string; blurb: string }[] = [
  { id: 'spike', label: 'Traffic spike', blurb: 'Load triples for about 20 s' },
  { id: 'nodeFailure', label: 'Node failure', blurb: 'One app instance dies mid-traffic' },
  { id: 'slowDb', label: 'Slow database', blurb: 'Queries become 4× slower' },
  { id: 'cacheFlush', label: 'Cache flush', blurb: 'The cache empties and the database takes the full load' },
  { id: 'retryStorm', label: 'Retry storm', blurb: 'A 10 s slowdown; watch retries pile extra load on top' },
  { id: 'zoneOutage', label: 'Zone outage', blurb: 'A failure zone goes: half the servers, and the database primary' },
  { id: 'grayFailure', label: 'Gray failure', blurb: 'A tier looks alive to health checks but is 4× slower' },
  { id: 'badDeploy', label: 'Bad deploy', blurb: 'A faulty release makes 30% of requests fail' },
  { id: 'thunderingHerd', label: 'Thundering herd', blurb: 'Servers restart together, behind cold caches' },
  { id: 'botFlood', label: 'Bot flood', blurb: 'One client suddenly sends 8× its traffic' },
  { id: 'hotPartition', label: 'Hot partition', blurb: 'One key dominates and a single shard or partition takes most of the load' },
]

/** The original stress tests. The suite behind the review, the fix search and the failing-count badge runs only these, to stay quick. */
export const SUITE_IDS: ScenarioId[] = ['spike', 'nodeFailure', 'slowDb']

export interface ScenarioPlan {
  id: ScenarioId
  label: string
  /** Traffic shape to switch to (restored when the scenario stops). */
  shape?: TrafficShape
  /** Faults to inject, keyed by component id. */
  injections: Record<string, Injected>
  /** Sim seconds after the start at which the fault lands (baseline traffic runs first). */
  at: number
  /** If set, the faults are lifted at this sim second (a brief failure rather than a lasting one). */
  until?: number
  summary: string
  /** Set when the architecture has nothing this scenario can act on. */
  empty?: string
}

const entryTier = (comps: ArchComponent[]) => comps.find((c) => c.kind === 'appServers') ?? comps.find((c) => c.kind === 'serverless')

/** Pure: decides what a scenario does to the given architecture. */
export function planScenario(arch: Architecture, id: ScenarioId): ScenarioPlan {
  const label = SCENARIOS.find((s) => s.id === id)!.label
  const comps = arch.components
  const none = (at: number, empty: string): ScenarioPlan => ({ id, label, injections: {}, at, summary: '', empty })
  switch (id) {
    case 'spike':
      return { id, label, shape: 'spike', injections: {}, at: 0, summary: 'Traffic ramps to 3× after about 10 s.' }
    case 'nodeFailure': {
      const target = comps.find((c) => c.kind === 'appServers') ?? comps.find((c) => c.kind !== 'client' && c.kind !== 'loadBalancer')
      if (!target) return none(5, 'Add an App Servers (or any non-client) component first.')
      return { id, label, injections: { [target.id]: 'lostInstance' }, at: 5, summary: `One instance of ${target.name} fails after 5 s.` }
    }
    case 'slowDb': {
      const dbs = comps.filter((c) => c.kind === 'database')
      if (!dbs.length) return none(5, 'Add a Database first.')
      return { id, label, injections: Object.fromEntries(dbs.map((d) => [d.id, 'slow' as const])), at: 5, summary: `${dbs.map((d) => d.name).join(', ')} slows down after 5 s.` }
    }
    case 'cacheFlush': {
      const caches = comps.filter((c) => c.kind === 'cache' || c.kind === 'cdn')
      if (!caches.length) return none(5, 'Add a Cache or CDN first.')
      return { id, label, injections: Object.fromEntries(caches.map((c) => [c.id, 'flushed' as const])), at: 5, summary: `${caches.map((c) => c.name).join(', ')} is flushed after 5 s and refills from cold.` }
    }
    case 'retryStorm': {
      const t = entryTier(comps)
      if (!t) return none(5, 'Add an App Servers or Serverless component first.')
      return { id, label, injections: { [t.id]: 'slow' }, at: 5, until: 15, summary: `${t.name} slows down for 10 s, from 5 s to 15 s. Watch how much extra load the retries add, and whether it recovers when the slowdown ends.` }
    }
    case 'zoneOutage': {
      const inj: Record<string, Injected> = {}
      for (const c of comps) {
        if (c.kind === 'appServers') inj[c.id] = 'zoneLoss'
        else if (c.kind === 'database') inj[c.id] = 'killed'
      }
      if (!Object.keys(inj).length) return none(5, 'Add App Servers or a Database first.')
      return { id, label, injections: inj, at: 5, summary: 'After 5 s a failure zone is lost: half of each server tier and the database primary (a replica takes over, after the failover time).' }
    }
    case 'grayFailure': {
      const t = entryTier(comps)
      if (!t) return none(5, 'Add an App Servers or Serverless component first.')
      return { id, label, injections: { [t.id]: 'slow' }, at: 5, summary: `${t.name} becomes 4× slower after 5 s but still answers health checks, so nothing takes it out of rotation.` }
    }
    case 'badDeploy': {
      const t = entryTier(comps)
      if (!t) return none(5, 'Add an App Servers or Serverless component first.')
      return { id, label, injections: { [t.id]: 'bad' }, at: 5, summary: `A faulty release reaches ${t.name} after 5 s: capacity is fine, but 30% of requests fail. Restore it from the inspector to roll back.` }
    }
    case 'botFlood': {
      const clients = comps.filter((c) => c.kind === 'client')
      if (!clients.length) return none(5, 'Add a Client first.')
      const bot = clients.find((c) => Math.round(c.config.clientType ?? 0) === 2) ?? clients[clients.length - 1]
      return { id, label, injections: { [bot.id]: 'flood' }, at: 5, summary: `After 5 s ${bot.name} sends 8× its normal traffic. A rate limit with a per-client allowance keeps the other clients served.` }
    }
    case 'hotPartition': {
      const hot = comps.filter((c) => (c.kind === 'database' && (c.config.shards ?? 1) > 1) || (c.kind === 'queue' && (c.config.partitions ?? 0) > 1))
      if (!hot.length) return none(5, 'Needs a sharded database (2+ shards) or a partitioned queue (2+ partitions).')
      return { id, label, injections: Object.fromEntries(hot.map((c) => [c.id, 'hotKey' as const])), at: 5, summary: `After 5 s one key dominates: 60% of the traffic to ${hot.map((c) => c.name).join(', ')} lands on a single ${hot.some((c) => c.kind === 'database') ? 'shard' : 'partition'}, so the average looks fine while that one is overloaded.` }
    }
    case 'thunderingHerd': {
      const apps = comps.filter((c) => c.kind === 'appServers')
      if (!apps.length) return none(5, 'Add an App Servers component first.')
      const inj: Record<string, Injected> = Object.fromEntries(apps.map((c) => [c.id, 'killed' as const]))
      for (const c of comps) if (c.kind === 'cache' || c.kind === 'cdn') inj[c.id] = 'flushed'
      return { id, label, injections: inj, at: 5, until: 13, summary: 'Everything restarts at 5 s: servers are down for 8 s and caches come back empty. When the servers return, all of the load meets a cold cache at once.' }
    }
  }
}
