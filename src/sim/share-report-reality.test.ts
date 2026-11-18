import { describe, expect, it } from 'vitest'
import { decodeShare, encodeShare, SHARE_MAX, SHARE_PREFIX } from './share'
import { compareToReality, project, CLOSE_FACTOR } from './reality'
import { parseProject, serializeProject } from '../store/project'
import { useStore, designChanged } from '../store/useStore'
import { linkShortener } from '../presets/linkShortener'
import type { Architecture } from '../store/types'

describe('share links', () => {
  it('round-trips a design through an address hash', () => {
    const hash = encodeShare(linkShortener)!
    expect(hash.startsWith(SHARE_PREFIX)).toBe(true)
    const r = decodeShare(hash)!
    expect(r.ok && r.arch).toEqual(parseProject(serializeProject(linkShortener)).ok ? (parseProject(serializeProject(linkShortener)) as { arch: Architecture }).arch : null)
  })
  it('carries unicode names, experiments and measured numbers', () => {
    const arch: Architecture = { ...linkShortener, name: 'Ünïcode · 日本語 🚀', experiments: [{ id: 'e', name: 'x', events: [{ at: 5, target: 'app', action: 'killed' }] }], actual: { p99Ms: 120 } }
    const r = decodeShare(encodeShare(arch)!)!
    expect(r.ok && r.arch.name).toBe('Ünïcode · 日本語 🚀')
    expect(r.ok && r.arch.experiments).toHaveLength(1)
    expect(r.ok && r.arch.actual).toEqual({ p99Ms: 120 })
  })
  it('uses only characters that are safe in an address', () => {
    expect(encodeShare(linkShortener)!.slice(SHARE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('ignores addresses that are not share links', () => {
    expect(decodeShare('')).toBeNull()
    expect(decodeShare('#about')).toBeNull()
    expect(decodeShare('#d=v2.abc')).toBeNull()
  })
  it('refuses anything damaged, hostile or too long, without throwing', () => {
    for (const bad of [SHARE_PREFIX + '***', SHARE_PREFIX + 'a', SHARE_PREFIX + '%%%%', SHARE_PREFIX + btoa('not json'), SHARE_PREFIX + btoa('{"app":"other","version":1}'), SHARE_PREFIX + 'A'.repeat(SHARE_MAX + 1)]) {
      const r = decodeShare(bad)!
      expect(r.ok).toBe(false)
    }
  })
  it('sanitises what it opens, like any imported file', () => {
    const evil = JSON.stringify({ app: 'cloudsim', version: 1, architecture: { name: 'x'.repeat(500), components: [{ id: 'a', kind: 'client', name: '<img src=x onerror=alert(1)>', position: { col: 0, row: 0 }, config: { rps: 1e12 } }], connections: [{ id: 'c', from: 'a', to: 'missing' }] } })
    const hash = SHARE_PREFIX + btoa(evil).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const r = decodeShare(hash)!
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.arch.name.length).toBeLessThanOrEqual(60)
      expect(r.arch.components[0].config.rps).toBe(5000) // clamped to the allowed range
      expect(r.arch.connections).toEqual([])
      expect(r.warnings.length).toBeGreaterThan(0)
    }
  })
  it('refuses to make a link for a design that is too big', () => {
    const many = { ...linkShortener, components: Array.from({ length: 60 }, (_, i) => ({ ...linkShortener.components[2], id: `a${i}`, name: 'x'.repeat(40), position: { col: i * 2, row: 0 }, assumed: Object.keys(linkShortener.components[2].config) })), connections: [] }
    const h = encodeShare({ ...many, experiments: Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: 'n'.repeat(60), events: Array.from({ length: 30 }, () => ({ at: 1, target: 'a0', action: 'slow' as const })) })) })
    expect(h === null || h.length <= SHARE_MAX).toBe(true)
  })
})

describe('reality check', () => {
  const proj = { p99Ms: 100, errorPct: 0, maxRps: 1000 }
  const gap = (a: Parameters<typeof compareToReality>[1]) => compareToReality(linkShortener, a, proj)
  it('compares only what was measured', () => {
    expect(gap({})).toEqual([])
    expect(gap({ p99Ms: 100 }).map((g) => g.metric)).toEqual(['p99'])
    expect(gap({ p99Ms: 1, errorPct: 1, maxRps: 1 }).map((g) => g.metric)).toEqual(['p99', 'errors', 'capacity'])
  })
  it('latency: slower in reality means the model is optimistic', () => {
    expect(gap({ p99Ms: 100 })[0].verdict).toBe('close')
    expect(gap({ p99Ms: 100 * CLOSE_FACTOR - 1 })[0].verdict).toBe('close')
    expect(gap({ p99Ms: 300 })[0].verdict).toBe('optimistic')
    expect(gap({ p99Ms: 30 })[0].verdict).toBe('pessimistic')
    expect(gap({ p99Ms: 300 })[0].ratio).toBeCloseTo(3, 6)
  })
  it('errors: compared in percentage points', () => {
    expect(gap({ errorPct: 0.2 })[0].verdict).toBe('close')
    expect(gap({ errorPct: 4 })[0].verdict).toBe('optimistic')
    expect(compareToReality(linkShortener, { errorPct: 0 }, { ...proj, errorPct: 5 })[0].verdict).toBe('pessimistic')
  })
  it('capacity: breaking sooner than the model says means the model is optimistic', () => {
    expect(gap({ maxRps: 1000 })[0].verdict).toBe('close')
    expect(gap({ maxRps: 400 })[0].verdict).toBe('optimistic')
    expect(gap({ maxRps: 2500 })[0].verdict).toBe('pessimistic')
  })
  it('skips capacity when the model has no figure for it', () => {
    expect(compareToReality(linkShortener, { maxRps: 500 }, { ...proj, maxRps: null })).toEqual([])
  })
  it('every verdict comes with a plain-language note', () => {
    for (const a of [{ p99Ms: 300 }, { p99Ms: 30 }, { errorPct: 9 }, { maxRps: 100 }, { maxRps: 9999 }, { p99Ms: 100 }]) expect(gap(a)[0].note.length).toBeGreaterThan(30)
  })
  it('projects from the engine: a healthy design has no errors and a plausible p99', () => {
    const p = project(linkShortener)
    expect(p.errorPct).toBeLessThan(0.1)
    expect(p.p99Ms).toBeGreaterThan(20)
    expect(p.maxRps).toBeGreaterThan(600)
  })
  it('is saved with the design, sanitised, and does not count as a design change', () => {
    const file = JSON.parse(serializeProject({ ...linkShortener, actual: { p99Ms: 250, errorPct: 1.5 } }))
    file.architecture.actual.maxRps = -5
    file.architecture.actual.errorPct = 400
    const r = parseProject(JSON.stringify(file))
    expect(r.ok && r.arch.actual).toEqual({ p99Ms: 250, errorPct: 100, maxRps: 1 })
    const before = useStore.getState().architecture
    useStore.getState().setActual({ p99Ms: 300 })
    expect(useStore.getState().architecture.actual).toEqual({ p99Ms: 300 })
    expect(designChanged(before, useStore.getState().architecture)).toBe(false)
    useStore.getState().setActual(null)
    expect('actual' in useStore.getState().architecture).toBe(false)
  })
})
