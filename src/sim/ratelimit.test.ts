import { describe, expect, it } from 'vitest'
import { analyze } from './insight'
import { freshState, step, type Injected, type SimState, type StepResult } from './engine'
import { planScenario } from './scenarios'
import type { Architecture } from '../store/types'

const gateArch = (gate: Record<string, number>, clients: { id: string; rps: number; type?: number }[] = [{ id: 'c1', rps: 1500 }]): Architecture => ({
  name: 'gate',
  components: [
    ...clients.map((c, i) => ({ id: c.id, kind: 'client' as const, name: `Client ${c.id}`, position: { col: 0, row: i * 3 }, config: { rps: c.rps, retries: 0, ...(c.type !== undefined ? { clientType: c.type } : {}) } })),
    { id: 'gw', kind: 'gateway' as const, name: 'Gateway', position: { col: 4, row: 0 }, config: { rateLimit: 1000, ...gate } },
    { id: 'app', kind: 'appServers' as const, name: 'App', position: { col: 8, row: 0 }, config: { instances: 8, vcpu: 8, ramGb: 16 } },
  ],
  connections: [...clients.map((c, i) => ({ id: `e${i}`, from: c.id, to: 'gw' })), { id: 'out', from: 'gw', to: 'app' }],
})

function runSteps(arch: Architecture, seconds: number, state = freshState(), injected?: Record<string, Injected>): { state: SimState; res: StepResult; each: StepResult[] } {
  let s = state
  let res = step(arch, s, 0, { shape: 'steady', injected }).result
  const each: StepResult[] = []
  for (let i = 0; i < seconds * 10; i++) { const o = step(arch, s, 0.1, { shape: 'steady', injected }); s = o.state; res = o.result; each.push(res) }
  return { state: s, res, each }
}

describe('fixed limit (the default)', () => {
  it('turns away everything over the limit, immediately', () => {
    const { res } = runSteps(gateArch({}), 3)
    expect(res.nodes.gw.served).toBeCloseTo(1000, 0)
    expect(res.nodes.gw.dropped).toBeCloseTo(500, 0)
    expect(res.nodes.gw.limiter?.algo).toBe(0)
  })
})

describe('token bucket', () => {
  const tb = { limitAlgo: 1, burstSec: 2 } // 1000 rps, bucket of 2000 tokens
  it('lets a burst through on top of the limit while the bucket lasts', () => {
    const { each } = runSteps(gateArch(tb), 2)
    expect(each[5].nodes.gw.served).toBeCloseTo(1500, -1) // all 1500 pass at 0.6 s
    expect(each[5].nodes.gw.dropped).toBeLessThan(5)
  })
  it('then holds the line at the limit once the bucket is empty', () => {
    const { res } = runSteps(gateArch(tb), 8)
    expect(res.nodes.gw.served).toBeCloseTo(1000, -1)
    expect(res.nodes.gw.limiter!.level).toBeLessThan(50)
    expect(res.nodes.gw.dropped).toBeGreaterThan(400)
  })
  it('refills during a quiet period, so the next burst is allowed again', () => {
    const drained = runSteps(gateArch(tb), 8)
    const quiet = runSteps(gateArch(tb, [{ id: 'c1', rps: 200 }]), 4, drained.state)
    expect(quiet.res.nodes.gw.limiter!.level).toBeGreaterThan(1900) // back to full
    const burst = runSteps(gateArch(tb), 0.6, quiet.state)
    expect(burst.res.nodes.gw.dropped).toBeLessThan(5)
  })
  it('reports the configured limit, not the transient burst capacity', () => {
    expect(runSteps(gateArch(tb), 1).res.nodes.gw.capacity).toBe(1000)
  })
  it('a longer burst allowance carries a burst for longer', () => {
    const firstDrop = (burstSec: number) => runSteps(gateArch({ limitAlgo: 1, burstSec }), 15).each.findIndex((r) => r.nodes.gw.dropped > 50)
    expect(firstDrop(6)).toBeGreaterThan(firstDrop(1) * 2)
  })
})

describe('leaky bucket', () => {
  const lb = { limitAlgo: 2, burstSec: 2 } // holds up to 2000 requests
  it('queues the excess instead of dropping it, and makes those requests wait', () => {
    const { each } = runSteps(gateArch(lb), 2)
    const r = each[each.length - 1].nodes.gw
    expect(r.limiter!.level).toBeGreaterThan(300)
    expect(r.dropped).toBeLessThan(5)
    expect(r.latency).toBeGreaterThan(300) // waiting in line
  })
  it('releases traffic downstream no faster than the limit', () => {
    const { res } = runSteps(gateArch(lb), 2)
    expect(res.nodes.app.offered).toBeLessThanOrEqual(1010)
  })
  it('drops once the queue is full', () => {
    const { res } = runSteps(gateArch(lb), 10)
    expect(res.nodes.gw.limiter!.level).toBeCloseTo(2000, -1)
    expect(res.nodes.gw.dropped).toBeGreaterThan(400)
  })
  it('a fixed limit is faster than a leaky bucket for the requests it lets through', () => {
    const fixed = runSteps(gateArch({}), 4).res.nodes.gw.latency
    const leaky = runSteps(gateArch(lb), 4).res.nodes.gw.latency
    expect(leaky).toBeGreaterThan(fixed * 10)
  })
})

describe('per-client limits', () => {
  const clients = [{ id: 'bot', rps: 3000, type: 2 }, { id: 'user', rps: 300, type: 0 }]
  const global = gateArch({ rateLimit: 2000 }, clients)
  const perClient = gateArch({ rateLimit: 2000, perClientOn: 1, perClientRps: 500 }, clients)
  it('without them a noisy client takes most of the shared limit, so everyone loses', () => {
    const r = runSteps(global, 3).res.nodes.gw.limiter!.passShare
    expect(r.user).toBeCloseTo(2000 / 3300, 1)
    expect(r.bot).toBeCloseTo(2000 / 3300, 1)
  })
  it('with them the noisy client is capped on its own and the others are untouched', () => {
    const r = runSteps(perClient, 3).res.nodes.gw
    expect(r.limiter!.passShare.user).toBeCloseTo(1, 2)
    expect(r.limiter!.passShare.bot).toBeCloseTo(500 / 3000, 2)
    expect(r.limiter!.limitedByClient).toBeCloseTo(2500, -1)
    expect(runSteps(perClient, 3).res.nodes.app.offered).toBeCloseTo(800, -1)
  })
  it('what a client sends over its own limit is counted as dropped, like any other 429', () => {
    const r = runSteps(perClient, 3).res
    expect(r.nodes.gw.offered).toBeCloseTo(3300, -1)
    expect(r.nodes.gw.dropped).toBeCloseTo(2500, -1)
  })
})

describe('bot flood', () => {
  const clients = [{ id: 'user', rps: 300, type: 0 }, { id: 'bot', rps: 200, type: 2 }]
  it('picks the bot and floods it', () => {
    expect(planScenario(gateArch({}, clients), 'botFlood').injections).toEqual({ bot: 'flood' })
    expect(planScenario({ name: 'x', components: [], connections: [] }, 'botFlood').empty).toBeTruthy()
  })
  it('a flood is eight times the normal traffic', () => {
    expect(runSteps(gateArch({ rateLimit: 10000 }, clients), 2, freshState(), { bot: 'flood' }).res.nodes.bot.offered).toBeCloseTo(1600, -1)
  })
  it('a per-client limit keeps the other clients served through a flood', () => {
    const limited = gateArch({ rateLimit: 2000, perClientOn: 1, perClientRps: 400 }, clients)
    const shared = gateArch({ rateLimit: 2000 }, clients)
    // the flood alone is 1600 rps, so a 900 rps limit is overwhelmed; what matters is who gets through
    const tight = (a: Architecture) => ({ ...a, components: a.components.map((c) => (c.id === 'gw' ? { ...c, config: { ...c.config, rateLimit: 900 } } : c)) })
    expect(runSteps(tight(limited), 4, freshState(), { bot: 'flood' }).res.nodes.gw.limiter!.passShare.user).toBeGreaterThan(0.99)
    expect(runSteps(tight(shared), 4, freshState(), { bot: 'flood' }).res.nodes.gw.limiter!.passShare.user).toBeLessThan(0.6)
  })
  it('the gateway shows as strained, not failed, while it is doing its job', () => {
    const { res } = runSteps(gateArch({ rateLimit: 900 }, clients), 4, freshState(), { bot: 'flood' })
    expect(res.nodes.gw.health).toBe('strained')
    expect(analyze(gateArch({ rateLimit: 900 }, clients), res)).toBeNull()
  })
})
