import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step, type Injected, type TrafficShape } from './engine'
import { planScenario } from './scenarios'
import { linkShortener } from '../presets/linkShortener'

function run(seconds: number, shape: TrafficShape, injected?: Record<string, Injected>) {
  let state = freshState()
  let last = step(linkShortener, state, 0, { shape, injected })
  for (let i = 0; i < seconds * 10; i++) {
    last = step(linkShortener, state, 0.1, { shape, injected })
    state = last.state
  }
  return last.result
}

describe('scenarios', () => {
  it('plans a node failure against the app tier', () => {
    const p = planScenario(linkShortener, 'nodeFailure')
    expect(p.injections).toEqual({ app: 'lostInstance' })
    expect(p.empty).toBeUndefined()
  })
  it('plans a slow database and reports when there is none', () => {
    expect(planScenario(linkShortener, 'slowDb').injections).toEqual({ db: 'slow' })
    const noDb = { ...linkShortener, components: linkShortener.components.filter((c) => c.kind !== 'database') }
    expect(planScenario(noDb, 'slowDb').empty).toBeTruthy()
  })
  it('spike switches the traffic shape', () => {
    expect(planScenario(linkShortener, 'spike').shape).toBe('spike')
  })
})

describe('lost instance', () => {
  it('removes one instance of capacity but keeps the tier alive', () => {
    const r = run(3, 'steady', { app: 'lostInstance' })
    expect(r.nodes.app.capacity).toBe(500) // 2 instances × 500 → 1
    expect(r.nodes.app.down).toBe(false)
  })
  it('a lone instance means the component is down', () => {
    const one = { ...linkShortener, components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, instances: 1 } } : c)) }
    const r = step(one, freshState(), 0, { shape: 'steady', injected: { app: 'lostInstance' } }).result
    expect(r.nodes.app.down).toBe(true)
  })
})

describe('insight', () => {
  it('is quiet when healthy', () => {
    expect(analyze(linkShortener, run(10, 'steady'))).toBeNull()
  })
  it('explains a spike overloading the app tier, with the retry storm', () => {
    const i = analyze(linkShortener, run(30, 'spike'))!
    expect(i.nodeId).toBe('app')
    expect(i.title).toMatch(/bottleneck/)
    expect(i.reasons.join(' ')).toMatch(/can only handle/)
    expect(i.reasons.join(' ')).toMatch(/retry storm/)
  })
  it('explains a slow database through the connection pool', () => {
    const i = analyze(linkShortener, run(10, 'steady', { db: 'slow' }))
    expect(i?.nodeId).toBe('db')
    expect(i?.title).toMatch(/slow/)
  })
  it('explains a dead component', () => {
    const i = analyze(linkShortener, run(5, 'steady', { cache: 'killed' }))!
    expect(i.nodeId).toBe('cache')
    expect(i.title).toMatch(/down/)
  })
})
