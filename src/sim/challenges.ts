/**
 * Guided challenges: a design that has a problem, goals to meet, and hints. Goals are checked by running the same
 * engine as everything else, so a design that meets them does so for the same reasons it would on the canvas.
 * Pure functions; the UI lives in panels/Challenges.tsx.
 */
import type { Architecture } from '../store/types'
import { freshState, step } from './engine'
import { runScenario } from './headless'
import { recoveryObjectives } from './review'
import { SCENARIOS, type ScenarioId } from './scenarios'
import { PRESETS } from '../presets/index'
import { linkShortener } from '../presets/linkShortener'

export type Goal =
  /** Errors never exceed 2 % of requests during the scenario. */
  | { kind: 'survive'; scenario: ScenarioId }
  /** Errors are back under 2 % `bySec` seconds into the scenario run (it may fail meanwhile). */
  | { kind: 'recover'; scenario: ScenarioId; bySec: number }
  /** Steady-state cost per hour stays at or under the budget. */
  | { kind: 'cost'; maxPerHour: number }
  /** Every database recovers within `maxRtoSec` and loses at most `maxRpoSec` of writes if its primary dies. */
  | { kind: 'recovery'; maxRtoSec: number; maxRpoSec: number }

export type Level = 'beginner' | 'intermediate' | 'advanced'

export interface Challenge {
  id: string
  title: string
  level: Level
  /** The situation, in a couple of sentences. */
  story: string
  start: Architecture
  goals: Goal[]
  /** Nudges, gentlest first. */
  hints: string[]
  /** What was really going on. Shown only once the challenge is solved. */
  rootCause: string
  /** Ideas it teaches. */
  concepts: string[]
  /** Set for challenges that retell a kind of real-world incident, rather than a drill. */
  incident?: boolean
}

export interface GoalResult { goal: Goal; label: string; ok: boolean; detail: string }
export interface Evaluation { results: GoalResult[]; passed: boolean; met: number }

const scenarioLabel = (id: ScenarioId) => SCENARIOS.find((s) => s.id === id)!.label
export function goalLabel(g: Goal): string {
  switch (g.kind) {
    case 'survive': return `Survive "${scenarioLabel(g.scenario)}" with errors under 2%`
    case 'recover': return `Be back under 2% errors within ${g.bySec} s of "${scenarioLabel(g.scenario)}" starting`
    case 'cost': return `Cost no more than $${g.maxPerHour.toFixed(2)} per hour (estimate)`
    case 'recovery': return `Lose at most ${g.maxRpoSec} s of writes and be back within ${g.maxRtoSec} s if a database primary dies`
  }
}

const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`

export function evaluate(arch: Architecture, ch: Challenge): Evaluation {
  const cache = new Map<ScenarioId, ReturnType<typeof runScenario>>()
  const run = (id: ScenarioId) => { let r = cache.get(id); if (!r) { r = runScenario(arch, id); cache.set(id, r) } return r }
  const results: GoalResult[] = ch.goals.map((goal) => {
    const label = goalLabel(goal)
    switch (goal.kind) {
      case 'survive': {
        const r = run(goal.scenario)
        if (r.skipped) return { goal, label, ok: false, detail: r.skipped }
        return { goal, label, ok: r.passes, detail: r.passes ? `Peak errors ${pct(r.peakErr)}.` : `Peak errors reached ${pct(r.peakErr)}, above 2% for ${r.errSeconds} s.` }
      }
      case 'recover': {
        const r = run(goal.scenario)
        if (r.skipped) return { goal, label, ok: false, detail: r.skipped }
        const at = r.err[Math.min(r.err.length - 1, goal.bySec)] ?? 0
        const ok = at < 2
        return { goal, label, ok, detail: ok ? `Errors were ${at.toFixed(1)}% at ${goal.bySec} s.` : `Still at ${at.toFixed(0)}% errors after ${goal.bySec} s: it has not recovered.` }
      }
      case 'cost': {
        const cost = step(arch, freshState(), 0, { shape: 'steady' }).result.totals.cost
        return { goal, label, ok: cost <= goal.maxPerHour + 1e-9, detail: `$${cost.toFixed(2)} per hour.` }
      }
      case 'recovery': {
        const dbs = recoveryObjectives(arch)
        if (!dbs.length) return { goal, label, ok: false, detail: 'There is no database.' }
        const bad = dbs.find((d) => d.rtoSec === null || d.rpoSec === null || d.rtoSec > goal.maxRtoSec || d.rpoSec > goal.maxRpoSec)
        return { goal, label, ok: !bad, detail: bad ? `${bad.name}: ${bad.note}` : 'Every database can fail over in time without losing more than allowed.' }
      }
    }
  })
  const met = results.filter((r) => r.ok).length
  return { results, passed: met === results.length, met }
}

const withConfig = (arch: Architecture, id: string, config: Record<string, number>, name?: string): Architecture => ({
  ...arch,
  ...(name ? { name } : {}),
  components: arch.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...config } } : c)),
})
const feed = PRESETS.find((p) => p.id === 'feed')!.arch

export const CHALLENGES: Challenge[] = [
  {
    id: 'black-friday',
    title: 'The Black Friday spike',
    level: 'beginner',
    story: 'A link shortener has been shared by a huge account. Traffic triples for a while. The app tier falls over, and the database behind it is not far behind.',
    start: withConfig(linkShortener, 'client', {}, 'Challenge: Black Friday'),
    goals: [{ kind: 'survive', scenario: 'spike' }, { kind: 'cost', maxPerHour: 2 }],
    hints: ['Run the Traffic spike scenario and watch which component fails first.', 'The app tier needs to take three times the load. More instances, or bigger ones?', 'Once the app tier holds, look at the database: a better cache hit rate sends it fewer requests, and costs far less than a bigger database.'],
    rootCause: 'Two things were undersized for a 3× peak: the app tier, and the database that a 80% cache hit rate leaves with 20% of the traffic. Fixing only the first moves the failure one hop back. Capacity has to be checked along the whole path.',
    concepts: ['capacity planning', 'bottleneck shifting', 'cache hit rate'],
  },
  {
    id: 'lose-a-server',
    title: 'Lose a server, keep the site',
    level: 'beginner',
    story: 'Two app servers share the load, and each one is needed. When one of them dies, the other cannot carry everything.',
    start: withConfig(linkShortener, 'client', {}, 'Challenge: Lose a server'),
    goals: [{ kind: 'survive', scenario: 'nodeFailure' }, { kind: 'cost', maxPerHour: 1.6 }],
    hints: ['Run the Node failure scenario. How much capacity is left after one instance dies?', 'N+1: the tier must carry the full load with one instance missing.'],
    rootCause: 'The tier ran at about 60% of its total capacity, which looks comfortable, but losing one of two instances halves it. Headroom has to be measured with a failure already happened (N+1), not against the healthy fleet.',
    concepts: ['N+1 redundancy', 'headroom'],
  },
  {
    id: 'cache-forgets',
    title: 'When the cache forgets',
    level: 'intermediate',
    story: 'A routine restart empties the cache. For half a minute the database takes every read, then it starts to refill. The database does not survive the wait.',
    start: withConfig(linkShortener, 'client', {}, 'Challenge: When the cache forgets'),
    goals: [{ kind: 'survive', scenario: 'cacheFlush' }, { kind: 'cost', maxPerHour: 2 }],
    hints: ['Run the Cache flush scenario and look at how much traffic the database sees compared with normal.', 'A cold cache makes misses pile up: many requests ask for the same missing item. Is there a setting that collapses them into one load?', 'Even after that, the database sees much more than usual for a while. It needs to be able to take it.'],
    rootCause: 'A cache is a load-bearing wall, not an optimisation: the database was sized for 20% of the traffic. When the cache is cold, every miss went to the database, and without request coalescing the same item was loaded again and again (a stampede).',
    concepts: ['cache stampede', 'request coalescing', 'cold start'],
  },
  {
    id: 'outage-never-ends',
    title: 'The outage that would not end',
    level: 'intermediate',
    incident: true,
    story: 'A slow release makes the app tier crawl for ten seconds. The release is fixed, but the errors do not stop. Ten minutes later, they are still going.',
    start: withConfig(linkShortener, 'client', { retries: 5 }, 'Challenge: The outage that would not end'),
    goals: [{ kind: 'recover', scenario: 'retryStorm', bySec: 40 }],
    hints: ['Run the Retry storm scenario and watch the errors after second 15, when the slowdown is over.', 'Open the clients and look at the retry policy. Where does the extra load come from?', 'Retries add load exactly when the system is least able to take it. Fewer retries, or spreading them out with backoff and jitter, lets it recover.'],
    rootCause: 'A metastable failure. The slowdown was the trigger, but the clients kept it going: five retries per failed request meant the app tier was offered more than its capacity even after it had recovered, so it kept failing, which caused more retries. Retries with no backoff turn a brief problem into a lasting one.',
    concepts: ['retry storm', 'metastable failure', 'exponential backoff and jitter'],
  },
  {
    id: 'slow-database-cascade',
    title: 'The slow database that took down the app',
    level: 'advanced',
    incident: true,
    story: 'The database gets slow, not dead. The app servers wait on it, every worker is stuck, and soon the whole site is down, though nothing is wrong with the app tier itself.',
    start: withConfig(linkShortener, 'app', { blocking: 1 }, 'Challenge: The slow database'),
    goals: [{ kind: 'survive', scenario: 'slowDb' }, { kind: 'cost', maxPerHour: 1.5 }],
    hints: ['Run the Slow database scenario and open the app servers: look at the "held" workers in the explanation.', 'The app tier waits on the database for every request that reaches it. Which requests really have to?', 'A slow dependency only hurts requests that depend on it. Keep most of them off that path.'],
    rootCause: 'A cascading failure: workers that wait on a slow dependency are not free to serve anything else, so the app tier lost capacity in proportion to how slow the database got. Making the slow path rare (a better cache hit rate) protected the tier more cheaply than any amount of extra app servers, and the cost cap rules out throwing hardware at it.',
    concepts: ['cascading failure', 'backpressure', 'keeping slow dependencies off the hot path'],
  },
  {
    id: 'celebrity-shard',
    title: 'The celebrity problem',
    level: 'advanced',
    incident: true,
    story: 'The data is split over four shards, so there is plenty of room. Then one account goes viral and a single shard takes most of the traffic while the other three nap.',
    start: withConfig(feed, 'client', { rps: 550 }, 'Challenge: The celebrity problem'),
    goals: [{ kind: 'survive', scenario: 'hotPartition' }, { kind: 'cost', maxPerHour: 3 }],
    hints: ['Run the Hot partition scenario and look at the shard share in the database inspector.', 'More shards will not help when one key is the problem: the busiest shard is still one shard.', 'The hot key is read far more than it is written. What sits in front of a database to absorb repeated reads?'],
    rootCause: 'Sharding spreads keys, not popularity. One hot key lands on one shard however many shards there are, so total capacity stopped mattering and the busiest shard\'s capacity did. A cache in front absorbs repeated reads of the hot key, at a fraction of the price of bigger shards.',
    concepts: ['hot key', 'sharding limits', 'caching hot data'],
  },
  {
    id: 'zone-down',
    title: 'A zone goes dark',
    level: 'advanced',
    story: 'Half of the data centre loses power. The traffic is read-heavy, and the business can accept 20 seconds of downtime for the database and at most a second of lost writes.',
    start: withConfig(linkShortener, 'client', { readPct: 0.95 }, 'Challenge: A zone goes dark'),
    goals: [{ kind: 'survive', scenario: 'zoneOutage' }, { kind: 'recovery', maxRtoSec: 20, maxRpoSec: 1 }, { kind: 'cost', maxPerHour: 3 }],
    hints: ['Run the Zone outage scenario. Which components are affected?', 'A zone takes half the servers and the database primary with it. What carries on?', 'The database needs a replica to fail over to, and the failover time and replication lag are both settings.'],
    rootCause: 'Surviving a zone means every layer has a second zone to fall back to: servers sized so half of them can carry the load, and a database replica that can be promoted quickly with little lag. Failover time sets how long writes fail (RTO); replication lag sets how many acknowledged writes can be lost (RPO).',
    concepts: ['failure domains', 'RTO and RPO', 'failover'],
  },
]
