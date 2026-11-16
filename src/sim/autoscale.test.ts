import { describe, expect, it } from 'vitest'
import { linkShortener } from '../presets/linkShortener'
import { freshState, step, type SimState, type TrafficShape } from './engine'
import { runScenario } from './headless'
import type { Architecture } from '../store/types'
import { analyze } from './insight'

const withApp = (patch: Record<string, number>): Architecture => ({
  ...linkShortener,
  components: linkShortener.components.map((c) => (c.id === 'app' ? { ...c, config: { ...c.config, ...patch } } : c)),
})
const auto = withApp({ autoscale: 1, maxInstances: 8, warmupSec: 30 })

function simulate(arch: Architecture, phases: [TrafficShape, number][]) {
  let state: SimState = freshState()
  const log: { t: number; active: number; pending: number; capacity: number; err: number; cost: number }[] = []
  for (const [shape, seconds] of phases) {
    for (let i = 0; i < seconds * 10; i++) {
      const out = step(arch, state, 0.1, { shape })
      state = out.state
      const n = out.result.nodes.app
      log.push({ t: state.t, active: n.scaling?.active ?? 0, pending: n.scaling?.pending ?? 0, capacity: n.capacity, err: out.result.totals.errorRate, cost: out.result.totals.cost })
    }
  }
  return log
}
const at = (log: ReturnType<typeof simulate>, t: number) => log.find((l) => l.t >= t - 1e-9)!

describe('autoscaling', () => {
  it('does nothing when switched off (the default)', () => {
    const r = step(linkShortener, freshState(), 0, { shape: 'steady' }).result
    expect(r.nodes.app.scaling).toBeUndefined()
  })

  it('stays at the minimum under steady load', () => {
    const log = simulate(auto, [['steady', 60]])
    expect(log.every((l) => l.active === 2 && l.pending === 0)).toBe(true)
  })

  it('asks for instances as soon as load rises, but they only serve after the start-up delay', () => {
    const log = simulate(auto, [['spike', 60]])
    const ramp = log.find((l) => l.pending > 0)!
    expect(ramp.t).toBeGreaterThan(9) // not before the spike starts at ~10s
    expect(ramp.active).toBe(2) // requested, not yet serving
    const ready = log.find((l) => l.t > ramp.t && l.active > 2)!
    expect(ready.t - ramp.t).toBeGreaterThanOrEqual(29.9)
    expect(ready.t - ramp.t).toBeLessThan(31.5)
  })

  it('that lag lets errors through at first, then the tier catches up', () => {
    const log = simulate(auto, [['spike', 60]])
    const early = log.filter((l) => l.t > 12 && l.t < 30)
    expect(Math.max(...early.map((l) => l.err))).toBeGreaterThan(0.02) // during the delay
    const ready = log.find((l) => l.active > 2)!
    expect(at(log, ready.t + 5).capacity).toBeGreaterThan(at(log, ready.t - 5).capacity)
  })

  it('cannot lower the peak of a sudden spike (it is still starting), but shortens how long errors last', () => {
    const fixed = runScenario(withApp({}), 'spike')
    const quick = runScenario(withApp({ autoscale: 1, maxInstances: 8, warmupSec: 5 }), 'spike')
    expect(quick.errSeconds).toBeLessThan(fixed.errSeconds)
  })

  it('a start-up delay longer than the spike makes autoscaling useless against it', () => {
    const slow = runScenario(withApp({ autoscale: 1, maxInstances: 8, warmupSec: 120 }), 'spike')
    const fixed = runScenario(withApp({}), 'spike')
    expect(slow.errSeconds).toBeGreaterThanOrEqual(fixed.errSeconds)
  })

  it('handles a slow ramp well, because the delay is shorter than the climb', () => {
    const log = simulate(withApp({ autoscale: 1, maxInstances: 8, warmupSec: 15 }), [['ramp', 60]])
    const fixed = simulate(withApp({}), [['ramp', 60]])
    const bad = (l: typeof log) => l.filter((x) => x.err > 0.02).length
    expect(bad(log)).toBeLessThan(bad(fixed))
  })

  it('never exceeds the maximum', () => {
    const log = simulate(withApp({ autoscale: 1, maxInstances: 3, warmupSec: 5 }), [['spike', 60]])
    expect(Math.max(...log.map((l) => l.active + l.pending))).toBeLessThanOrEqual(3)
  })

  it('scales back in after the load has gone, but not immediately', () => {
    const log = simulate(auto, [['spike', 45], ['steady', 260]])
    const peak = Math.max(...log.map((l) => l.active))
    expect(peak).toBeGreaterThan(2)
    expect(at(log, 60).active).toBeGreaterThan(2) // still holding capacity shortly after the spike
    expect(log[log.length - 1].active).toBe(2) // eventually back to the minimum
  })

  it('costs less than running the maximum all the time, and more than the minimum while scaled out', () => {
    const log = simulate(auto, [['spike', 60]])
    const fixedMin = simulate(withApp({}), [['steady', 5]])[0].cost
    const fixedMax = simulate(withApp({ instances: 8 }), [['steady', 5]])[0].cost
    const peakCost = Math.max(...log.map((l) => l.cost))
    expect(peakCost).toBeGreaterThan(fixedMin)
    expect(peakCost).toBeLessThanOrEqual(fixedMax + 1e-9)
  })

  it('counts instances that are still starting towards the bill', () => {
    const log = simulate(auto, [['spike', 40]])
    const before = at(log, 5).cost
    const starting = log.find((l) => l.pending > 0 && l.active === 2)!
    expect(starting.cost).toBeGreaterThan(before)
  })

  it('the explanation card names the start-up gap while instances are still starting', () => {
    let state: SimState = freshState()
    let last = step(auto, state, 0, { shape: 'spike' })
    for (let i = 0; i < 200; i++) { last = step(auto, state, 0.1, { shape: 'spike' }); state = last.state } // t = 20 s, mid-spike
    const insight = analyze(auto, last.result)!
    expect(insight.nodeId).toBe('app')
    expect(insight.reasons[0]).toMatch(/Autoscaling is adding/)
    expect(insight.reasons.join(' ')).toMatch(/gap between a spike and new capacity/)
  })

  it('says so when autoscaling has hit its ceiling', () => {
    const capped = withApp({ autoscale: 1, maxInstances: 2 })
    let state: SimState = freshState()
    let last = step(capped, state, 0, { shape: 'spike' })
    for (let i = 0; i < 250; i++) { last = step(capped, state, 0.1, { shape: 'spike' }); state = last.state }
    expect(analyze(capped, last.result)!.reasons.join(' ')).toMatch(/already at its maximum of 2/)
  })

  it('replaces a failed instance, so a node failure recovers instead of lasting forever', () => {
    const fixed = runScenario(withApp({}), 'nodeFailure')
    const scaled = runScenario(auto, 'nodeFailure')
    expect(fixed.errSeconds).toBeGreaterThan(40) // never recovers
    expect(scaled.errSeconds).toBeLessThan(fixed.errSeconds - 20) // recovers once the replacement has started
    expect(scaled.err[scaled.err.length - 1]).toBeLessThan(2)
  })

  it('does not keep adding instances to a tier that is entirely down', () => {
    let state: SimState = freshState()
    let last = step(auto, state, 0, { shape: 'steady', injected: { app: 'killed' } })
    for (let i = 0; i < 400; i++) { last = step(auto, state, 0.1, { shape: 'steady', injected: { app: 'killed' } }); state = last.state }
    expect(last.result.nodes.app.scaling!.pending).toBe(0)
    expect(last.result.nodes.app.scaling!.active).toBe(2)
  })
})
