import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { runScenario, runSuite } from './headless'
import { addParallelCopy, diffArch, findSpofs, insertCacheBefore } from './review'
import { suggestFixes } from './fixes'
import { step, freshState } from './engine'

describe('headless runner', () => {
  it('matches the live engine: a calm design survives steady load', () => {
    const calm = { ...linkShortener, components: linkShortener.components }
    const r = step(calm, freshState(), 0, { shape: 'steady' }).result
    expect(r.totals.errorRate).toBe(0)
  })
  it('the starter preset fails all three stress scenarios', () => {
    const s = runSuite(linkShortener)
    expect(s.failing.sort()).toEqual(['nodeFailure', 'slowDb', 'spike'])
    expect(s.runs.every((r) => r.t.length === 61)).toBe(true)
  })
  it('skips a scenario the design cannot express', () => {
    const noDb = { ...linkShortener, components: linkShortener.components.filter((c) => c.kind !== 'database'), connections: linkShortener.connections.filter((e) => e.to !== 'db') }
    expect(runScenario(noDb, 'slowDb').skipped).toBeTruthy()
  })
})

describe('single points of failure', () => {
  it('flags the chain links that have no redundancy, not the scaled-out app tier', () => {
    const ids = findSpofs(linkShortener).map((s) => s.id).sort()
    expect(ids).toEqual(['cache', 'db', 'lb'])
  })
  it('a lone app instance becomes a SPOF', () => {
    const one = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 1 } } : c)) }
    expect(findSpofs(one).map((s) => s.id)).toContain('app')
  })
  it('a parallel copy removes the SPOF', () => {
    const copy = addParallelCopy(linkShortener, 'lb')!
    expect(copy.components).toHaveLength(linkShortener.components.length + 1)
    expect(findSpofs(copy).map((s) => s.id)).not.toContain('lb')
  })
})

describe('structural edits', () => {
  it('inserting a cache rewires calls through it', () => {
    const noCache = {
      ...linkShortener,
      components: linkShortener.components.filter((c) => c.id !== 'cache'),
      connections: [{ id: 'a', from: 'client', to: 'lb' }, { id: 'b', from: 'lb', to: 'app' }, { id: 'c', from: 'app', to: 'db' }],
    }
    const out = insertCacheBefore(noCache, 'db')!
    const cache = out.components.find((c) => c.kind === 'cache')!
    expect(out.connections.some((e) => e.from === 'app' && e.to === cache.id)).toBe(true)
    expect(out.connections.some((e) => e.from === cache.id && e.to === 'db')).toBe(true)
    expect(out.connections.some((e) => e.from === 'app' && e.to === 'db')).toBe(false)
  })
  it('diff describes added parts and changed settings in words', () => {
    const b = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 4 } } : c)) }
    expect(diffArch(linkShortener, b).map((c) => c.text)).toEqual(['App Servers: Instances (scale out) 2 → 4'])
  })
})

describe('suggested fixes', () => {
  const { before, fixes } = suggestFixes(linkShortener)
  it('finds fixes, each measurably better than the starting design', () => {
    expect(fixes.length).toBeGreaterThan(0)
    for (const f of fixes) expect(f.after.score).toBeLessThan(before.score - 0.019)
  })
  it('the best fix reduces the number of failing scenarios', () => {
    expect(fixes[0].after.failing.length).toBeLessThan(before.failing.length)
  })
  it('reports what each fix costs', () => {
    expect(fixes.every((f) => Number.isFinite(f.costDelta))).toBe(true)
  })
  it('is empty when the design already survives', () => {
    const strong = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 6 } } : c.id === 'db' ? { ...c, config: { ...c.config, vcpu: 16, ramGb: 64 } } : c)) }
    const r = suggestFixes(strong)
    expect(r.before.failing).toEqual([])
    expect(r.fixes).toEqual([])
  })
})
