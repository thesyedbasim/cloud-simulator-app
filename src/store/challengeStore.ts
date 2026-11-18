import { create } from 'zustand'
import type { Architecture } from './types'

const KEY = 'cloudsim:challenges:v1'

/** Solved challenge ids, kept in browser storage. Every access is guarded: storage can be blocked, full, or corrupt. */
function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100) : []
  } catch { return [] }
}
function save(ids: string[]) { try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* nothing to do */ } }

/** Where a challenge is in its game loop: shaping the design, watching it run, or the verdict. null = no challenge in progress. */
export type Phase = 'design' | 'running' | 'won' | 'lost'

export interface Outcome {
  won: boolean
  /** Why, in a sentence. */
  detail: string
  /** Sim second the run ended on. */
  at: number
  goals: { label: string; ok: boolean; detail: string }[]
}

interface ChallengeState {
  open: boolean
  /** The challenge being worked on (its goals are checked against the design as it changes). */
  activeId: string | null
  /** The challenge shown in the dialog's detail view. */
  viewId: string | null
  solved: string[]
  phase: Phase | null
  /** Which view the right-hand panel shows. */
  tab: 'inspector' | 'challenge'
  outcome: Outcome | null
  /** The design that was open before the challenge started, put back when it is left. */
  stash: Architecture | null
  setStash: (a: Architecture | null) => void
  /** Runs played on this challenge since it was started. */
  attempts: number
  setPhase: (p: Phase | null) => void
  setTab: (t: 'inspector' | 'challenge') => void
  setOutcome: (o: Outcome | null) => void
  beginAttempt: () => void
  setOpen: (o: boolean) => void
  view: (id: string | null) => void
  start: (id: string) => void
  abandon: () => void
  markSolved: (id: string) => void
}

export const useChallenges = create<ChallengeState>((set, get) => ({
  open: false,
  activeId: null,
  viewId: null,
  solved: load(),
  phase: null,
  tab: 'inspector',
  outcome: null,
  stash: null,
  setStash: (stash) => set({ stash }),
  attempts: 0,
  setPhase: (phase) => set({ phase }),
  setTab: (tab) => set({ tab }),
  setOutcome: (outcome) => set({ outcome }),
  beginAttempt: () => set((s) => ({ attempts: s.attempts + 1 })),
  setOpen: (open) => set({ open }),
  view: (viewId) => set({ viewId }),
  start: (id) => set({ activeId: id, viewId: id, phase: 'design', tab: 'challenge', outcome: null, attempts: 0 }),
  abandon: () => set({ activeId: null, phase: null, tab: 'inspector', outcome: null, attempts: 0, stash: null }),
  markSolved: (id) => { if (get().solved.includes(id)) return; const solved = [...get().solved, id]; save(solved); set({ solved }) },
}))

/** While a challenge run plays, the design is locked: every run tests one fixed design. */
export const runLocked = () => useChallenges.getState().phase === 'running'

/** Set while the challenge controller itself is loading a design, so that load does not end the challenge. */
export const challengeLoad = { on: false }
