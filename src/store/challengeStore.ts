import { create } from 'zustand'

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

interface ChallengeState {
  open: boolean
  /** The challenge being worked on (its goals are checked against the design as it changes). */
  activeId: string | null
  /** The challenge shown in the dialog's detail view. */
  viewId: string | null
  solved: string[]
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
  setOpen: (open) => set({ open }),
  view: (viewId) => set({ viewId }),
  start: (id) => set({ activeId: id, viewId: id }),
  abandon: () => set({ activeId: null }),
  markSolved: (id) => { if (get().solved.includes(id)) return; const solved = [...get().solved, id]; save(solved); set({ solved }) },
}))
