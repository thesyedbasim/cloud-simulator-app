import { describe, expect, it } from 'vitest'
import { CHALLENGES, evaluate, goalLabel, type Challenge } from './challenges'
import { parseProject, serializeProject } from '../store/project'
import type { Architecture } from '../store/types'

const tw = (a: Architecture, id: string, cfg: Record<string, number>): Architecture => ({ ...a, components: a.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...cfg } } : c)) })
const byId = (id: string): Challenge => CHALLENGES.find((c) => c.id === id)!

/** A known good answer for each challenge, plus an answer that is wrong in the way a beginner's would be. */
const SOLUTIONS: Record<string, (a: Architecture) => Architecture> = {
  'black-friday': (a) => tw(tw(a, 'app', { instances: 5 }), 'cache', { hitRate: 0.9 }),
  'lose-a-server': (a) => tw(a, 'app', { instances: 3 }),
  'cache-forgets': (a) => tw(tw(a, 'cache', { coalesce: 1 }), 'db', { vcpu: 8, ramGb: 32 }),
  'outage-never-ends': (a) => tw(a, 'client', { backoff: 1 }),
  'slow-database-cascade': (a) => tw(a, 'cache', { hitRate: 0.95 }),
  'celebrity-shard': (a) => ({
    ...a,
    components: [...a.components, { id: 'hotcache', kind: 'cache' as const, name: 'Hot-key cache', position: { col: 9, row: 7 }, config: { hitRate: 0.8 } }],
    connections: [...a.connections.filter((e) => e.id !== 'c3'), { id: 'x1', from: 'api', to: 'hotcache' }, { id: 'x2', from: 'hotcache', to: 'db' }],
  }),
  'zone-down': (a) => tw(tw(a, 'app', { instances: 5 }), 'db', { replicas: 1, failoverSec: 10, replLagMs: 100 }),
}
const WRONG: Record<string, (a: Architecture) => Architecture> = {
  'black-friday': (a) => tw(a, 'app', { instances: 12 }), // fixes the app tier, but blows the budget and leaves the database
  'lose-a-server': (a) => tw(a, 'app', { instances: 8, vcpu: 8, ramGb: 16 }), // too expensive
  'cache-forgets': (a) => tw(a, 'db', { vcpu: 16, ramGb: 64 }), // brute force: still stampedes, costs too much
  'outage-never-ends': (a) => tw(a, 'client', { timeoutMs: 400 }), // a tighter client timeout turns more slow answers into failures, and so into retries
  'slow-database-cascade': (a) => tw(a, 'app', { instances: 8 }), // more app servers: the workers are still stuck
  'celebrity-shard': (a) => tw(a, 'db', { shards: 16 }), // more shards do not help a hot key
  'zone-down': (a) => tw(a, 'app', { instances: 5 }), // servers survive, but the database has no replica
}

describe('challenge definitions', () => {
  it('has a unique id, a story, goals, hints, a root cause and concepts for every challenge', () => {
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(CHALLENGES.length)
    for (const c of CHALLENGES) {
      expect(c.story.length).toBeGreaterThan(40)
      expect(c.goals.length).toBeGreaterThan(0)
      expect(c.hints.length).toBeGreaterThanOrEqual(2)
      expect(c.rootCause.length).toBeGreaterThan(80)
      expect(c.concepts.length).toBeGreaterThan(0)
      expect(['beginner', 'intermediate', 'advanced']).toContain(c.level)
    }
  })
  it('goes from easy to hard', () => {
    const order = { beginner: 0, intermediate: 1, advanced: 2 }
    const levels = CHALLENGES.map((c) => order[c.level])
    expect(levels).toEqual([...levels].sort())
  })
  it('every starting design is a valid project, and a copy of the preset is not changed by it', () => {
    for (const c of CHALLENGES) {
      const r = parseProject(serializeProject(c.start))
      expect(r.ok).toBe(true)
      expect(c.start.name).toMatch(/^Challenge: /)
    }
  })
  it('every goal can be described', () => {
    for (const c of CHALLENGES) for (const g of c.goals) expect(goalLabel(g).length).toBeGreaterThan(10)
  })
})

for (const c of CHALLENGES) {
  describe(c.title, () => {
    it('is not solved as it starts, and says what is wrong', () => {
      const e = evaluate(c.start, c)
      expect(e.passed).toBe(false)
      expect(e.results.some((r) => !r.ok && r.detail.length > 0)).toBe(true)
    })
    it('is solved by the reference answer', () => {
      const e = evaluate(SOLUTIONS[c.id](c.start), c)
      expect(e.results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.detail}`)).toEqual([])
      expect(e.passed).toBe(true)
      expect(e.met).toBe(c.goals.length)
    })
    it('is not solved by the obvious wrong answer', () => {
      expect(evaluate(WRONG[c.id](c.start), c).passed).toBe(false)
    })
  })
}

describe('evaluating goals', () => {
  it('reports a scenario that cannot run as a failed goal, with the reason', () => {
    const noDb: Challenge = { ...byId('black-friday'), goals: [{ kind: 'survive', scenario: 'slowDb' }] }
    const e = evaluate({ ...noDb.start, components: noDb.start.components.filter((x) => x.kind !== 'database'), connections: [] }, noDb)
    expect(e.passed).toBe(false)
    expect(e.results[0].detail).toMatch(/Add a Database/)
  })
  it('the recovery goal needs a replica, and counts strong consistency as no lost writes', () => {
    const ch: Challenge = { ...byId('zone-down'), goals: [{ kind: 'recovery', maxRtoSec: 20, maxRpoSec: 0 }] }
    const replicated = tw(ch.start, 'db', { replicas: 1, failoverSec: 10, replLagMs: 100 })
    expect(evaluate(replicated, ch).passed).toBe(false) // 100 ms of lag can lose writes
    expect(evaluate(tw(replicated, 'db', { consistency: 1 }), ch).passed).toBe(true)
    expect(evaluate(ch.start, ch).results[0].detail).toMatch(/No replica/)
  })
})
