import { describe, expect, it } from 'vitest'
import { PRESETS } from './index'
import { freshState, step } from '../sim/engine'
import { runSuite } from '../sim/headless'
import { suggestFixes } from '../sim/fixes'

describe('starter presets', () => {
  it('has the four starters from the spec, then the data-tier ones', () => {
    expect(PRESETS.map((p) => p.name)).toEqual(['Link Shortener', 'Chat App', 'Video Streaming', 'E-commerce Store', 'Social Feed', 'Event Pipeline'])
  })
  for (const p of PRESETS) {
    describe(p.name, () => {
      it('is internally consistent', () => {
        const ids = new Set(p.arch.components.map((c) => c.id))
        expect(ids.size).toBe(p.arch.components.length)
        for (const e of p.arch.connections) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true) }
      })
      it('runs healthy at steady load, so the first thing a visitor sees is calm', () => {
        const r = step(p.arch, freshState(), 0, { shape: 'steady' }).result
        expect(r.totals.errorRate).toBeLessThan(0.001)
        expect(Object.values(r.nodes).every((n) => n.health !== 'failed')).toBe(true)
      })
      it('has a known weak point: it fails at least one scenario, so the first run teaches something', () => {
        expect(runSuite(p.arch).failing.length).toBeGreaterThan(0)
      })
      it('offers at least one fix that helps', () => {
        expect(suggestFixes(p.arch).fixes.length).toBeGreaterThan(0)
      })
    })
  }
})

describe('fix search', () => {
  it('combines changes on different components when no single change is enough', () => {
    const link = PRESETS[0].arch
    const { fixes } = suggestFixes(link)
    expect(fixes[0].after.failing).toEqual([])
    expect(fixes[0].title).toMatch(/, and /)
  })
})
