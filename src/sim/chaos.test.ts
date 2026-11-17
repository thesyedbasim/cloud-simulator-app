import { describe, expect, it } from 'vitest'
import { describeExperiment, experimentSeconds, faultsAt, faultsFor, MAX_EVENTS, MAX_EXPERIMENTS, sanitizeExperiments } from './chaos'
import { runExperiment, runScenario } from './headless'
import { parseProject, serializeProject } from '../store/project'
import { useStore, designChanged } from '../store/useStore'
import { linkShortener } from '../presets/linkShortener'
import type { ChaosEvent, Experiment } from '../store/types'

const exp = (events: ChaosEvent[], extra: Partial<Experiment> = {}): Experiment => ({ id: 'e1', name: 'Test', events, ...extra })

describe('faultsAt', () => {
  const events: ChaosEvent[] = [
    { at: 10, target: 'app', action: 'killed' },
    { at: 25, target: 'cache', action: 'flushed' },
    { at: 40, target: 'app', action: 'restore' },
  ]
  it('is empty before the first event', () => expect(faultsAt(events, 9.9)).toEqual({}))
  it('applies an event at its time', () => expect(faultsAt(events, 10)).toEqual({ app: 'killed' }))
  it('accumulates faults', () => expect(faultsAt(events, 30)).toEqual({ app: 'killed', cache: 'flushed' }))
  it('a restore lifts only its target', () => expect(faultsAt(events, 50)).toEqual({ cache: 'flushed' }))
  it('a later fault on the same target replaces the earlier one', () => {
    expect(faultsAt([{ at: 1, target: 'db', action: 'slow' }, { at: 2, target: 'db', action: 'killed' }], 5)).toEqual({ db: 'killed' })
  })
  it('does not care about the order the events were listed in', () => {
    expect(faultsAt([...events].reverse(), 50)).toEqual({ cache: 'flushed' })
  })
  it('events at the same moment apply in list order', () => {
    expect(faultsAt([{ at: 5, target: 'db', action: 'killed' }, { at: 5, target: 'db', action: 'restore' }], 5)).toEqual({})
    expect(faultsAt([{ at: 5, target: 'db', action: 'restore' }, { at: 5, target: 'db', action: 'killed' }], 5)).toEqual({ db: 'killed' })
  })
})

describe('helpers', () => {
  it('offers only the faults that make sense for a component', () => {
    expect(faultsFor('client')).toEqual(['flood'])
    expect(faultsFor('cache')).toContain('flushed')
    expect(faultsFor('database')).not.toContain('flushed')
    expect(faultsFor('appServers')).toContain('zoneLoss')
    for (const k of ['loadBalancer', 'gateway', 'bucket'] as const) expect(faultsFor(k)).toEqual(['killed', 'slow'])
  })
  it('runs until 30 s after the last event, and never under a minute', () => {
    expect(experimentSeconds(exp([{ at: 5, target: 'app', action: 'killed' }]))).toBe(60)
    expect(experimentSeconds(exp([{ at: 100, target: 'app', action: 'killed' }]))).toBe(130)
  })
  it('describes an experiment in plain words, in time order', () => {
    const lines = describeExperiment(exp([{ at: 20, target: 'cache', action: 'flushed' }, { at: 5, target: 'app', action: 'killed' }, { at: 30, target: 'gone', action: 'restore' }]), linkShortener)
    expect(lines[0]).toBe('at 5 s: Kill App Servers')
    expect(lines[1]).toBe('at 20 s: Flush Cache')
    expect(lines[2]).toMatch(/restore a component that no longer exists/)
  })
})

describe('running an experiment', () => {
  it('replays a scenario exactly: the same faults at the same times give the same result', () => {
    const scenario = runScenario(linkShortener, 'cacheFlush')
    const replay = runExperiment(linkShortener, exp([{ at: 5, target: 'cache', action: 'flushed' }]), 60)
    expect(replay.peakErr).toBeCloseTo(scenario.peakErr, 10)
    expect(replay.errSeconds).toBe(scenario.errSeconds)
    expect(replay.err).toEqual(scenario.err)
  })
  it('reproduces a brief failure, with a restore', () => {
    const scenario = runScenario(linkShortener, 'retryStorm')
    const replay = runExperiment(linkShortener, exp([{ at: 5, target: 'app', action: 'slow' }, { at: 15, target: 'app', action: 'restore' }]), 60)
    expect(replay.err).toEqual(scenario.err)
  })
  it('composes several faults in sequence: the design suffers from each, and recovers after the last', () => {
    const r = runExperiment(linkShortener, exp([
      { at: 5, target: 'app', action: 'lostInstance' },
      { at: 20, target: 'cache', action: 'flushed' },
      { at: 25, target: 'app', action: 'restore' },
    ]), 120)
    expect(r.peakErr).toBeGreaterThan(0.3)
    expect(r.err[2]).toBeLessThan(1) // calm before the first event
    expect(r.err[r.err.length - 1]).toBeLessThan(2) // recovered
    expect(r.firstFailure).not.toBeNull()
    expect(r.id).toBe('experiment')
  })
  it('uses the experiment\'s traffic shape', () => {
    const calm = runExperiment(linkShortener, exp([{ at: 50, target: 'db', action: 'slow' }]), 40)
    const spiky = runExperiment(linkShortener, exp([{ at: 50, target: 'db', action: 'slow' }], { shape: 'spike' }), 40)
    expect(spiky.peakErr).toBeGreaterThan(calm.peakErr)
  })
  it('an experiment with no events is a quiet run that survives', () => {
    expect(runExperiment(linkShortener, exp([]), 30).passes).toBe(true)
  })
  it('can be replayed against a changed design to see whether it helped', () => {
    const e = exp([{ at: 5, target: 'app', action: 'lostInstance' }])
    const before = runExperiment(linkShortener, e, 60)
    const bigger = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 4 } } : c)) }
    expect(runExperiment(bigger, e, 60).peakErr).toBeLessThan(before.peakErr)
  })
})

describe('saving with the design', () => {
  const saved = { ...linkShortener, experiments: [exp([{ at: 5, target: 'app', action: 'killed' }, { at: 20, target: 'app', action: 'restore' }], { shape: 'spike' })] }
  it('round-trips through a project file', () => {
    const r = parseProject(serializeProject(saved))
    expect(r.ok && r.arch.experiments).toEqual(saved.experiments)
  })
  it('a design with no experiments stays free of the field', () => {
    const r = parseProject(serializeProject(linkShortener))
    expect(r.ok && 'experiments' in r.arch).toBe(false)
  })
  it('drops events that point at a missing component or use an unknown fault, with a warning', () => {
    const file = JSON.parse(serializeProject(saved))
    file.architecture.experiments[0].events.push({ at: 3, target: 'nope', action: 'killed' }, { at: 4, target: 'app', action: 'explode' }, { at: 'x', target: 'app', action: 'slow' })
    const r = parseProject(JSON.stringify(file))
    expect(r.ok && r.arch.experiments![0].events).toHaveLength(2)
    expect(r.ok && r.warnings.join(' ')).toMatch(/chaos event/)
  })
  it('clamps times, caps sizes, and survives garbage', () => {
    const ids = new Set(['app'])
    const many = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => ({ at: i, target: 'app', action: 'slow' }))
    const out = sanitizeExperiments([{ id: 'a', name: '  ', shape: 'weird', events: [{ at: 9999, target: 'app', action: 'killed' }, { at: -5, target: 'app', action: 'restore' }] }, { id: 'b', name: 'big', events: many }, null, 'x', { id: 'a', events: [] }], ids)
    expect(out.experiments).toHaveLength(2)
    expect(out.experiments[0].name).toBe('Experiment')
    expect(out.experiments[0].shape).toBeUndefined()
    expect(out.experiments[0].events.map((e) => e.at)).toEqual([300, 0])
    expect(out.experiments[1].events).toHaveLength(MAX_EVENTS)
    expect(sanitizeExperiments('nonsense', ids).experiments).toEqual([])
    const lots = sanitizeExperiments(Array.from({ length: MAX_EXPERIMENTS + 5 }, (_, i) => ({ id: `x${i}`, name: 'n', events: [] })), ids)
    expect(lots.experiments).toHaveLength(MAX_EXPERIMENTS)
  })
  it('saving and deleting an experiment does not count as a change to the design (so the run is not restarted)', () => {
    const before = useStore.getState().architecture
    useStore.getState().saveExperiment(exp([{ at: 5, target: before.components[1].id, action: 'killed' }], { id: 'keep' }))
    const mid = useStore.getState().architecture
    expect(mid.experiments).toHaveLength(1)
    expect(designChanged(before, mid)).toBe(false)
    useStore.getState().saveExperiment({ ...exp([], { id: 'keep' }), name: 'Renamed' })
    expect(useStore.getState().architecture.experiments).toHaveLength(1)
    expect(useStore.getState().architecture.experiments![0].name).toBe('Renamed')
    useStore.getState().deleteExperiment('keep')
    expect(useStore.getState().architecture.experiments).toEqual([])
    expect(designChanged(before, useStore.getState().architecture)).toBe(false)
  })
})
