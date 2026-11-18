import { create } from 'zustand'
import { DEFAULT_CONFIG, KIND_INFO, type Actual, type Architecture, type ArchComponent, type ComponentKind, type Experiment, type Slo } from './types'
import { initialArchitecture } from './project'
import { findFreeCell } from './arch'
import { toast } from 'sonner'
import { runLocked, useChallenges } from './challengeStore'

export type ConnectResult = 'ok' | 'self' | 'duplicate' | 'reverse' | 'locked'
type Cell = { col: number; row: number }

interface UIState {
  architecture: Architecture
  /** When the design was last written to browser storage (null until the first save). */
  savedAt: number | null
  past: Architecture[]
  future: Architecture[]
  selectedId: string | null
  selectedConnId: string | null
  dragKind: ComponentKind | null
  hoverCell: Cell | null
  hoverId: string | null
  ctx: { id: string; x: number; y: number } | null
  /** Design A for compare mode: a snapshot of the architecture at the time it was pinned. */
  pinned: { arch: Architecture; at: number } | null
  review: { open: boolean; tab: 'review' | 'compare' | 'capacity' }
  leftOpen: boolean
  rightOpen: boolean

  select: (id: string | null) => void
  selectConn: (id: string | null) => void
  setDragKind: (k: ComponentKind | null) => void
  setHoverCell: (c: Cell | null) => void
  setHoverId: (id: string | null) => void
  openCtx: (id: string, x: number, y: number) => void
  setSavedAt: (t: number) => void
  /** Replace the whole design with another (a preset, an import, a blank canvas) as one undo step. */
  loadArchitecture: (arch: Architecture) => void
  renameProject: (name: string) => void
  /** Change the service-level targets. Not part of the undo history, and does not restart the run. */
  setSlo: (patch: Partial<Slo>) => void
  /** Save (add or replace) a chaos experiment with the design. Not part of the undo history, and does not restart the run. */
  saveExperiment: (exp: Experiment) => void
  /** Set the measured numbers to compare with the model (null clears them). Not part of the undo history, and does not restart the run. */
  setActual: (actual: Actual | null) => void
  deleteExperiment: (id: string) => void
  pin: () => void
  unpin: () => void
  setReview: (open: boolean, tab?: 'review' | 'compare' | 'capacity') => void
  /** Replace the whole design as ONE undo step (used by suggested fixes). Pins the previous design as A if none is pinned. */
  applyArchitecture: (arch: Architecture) => void
  closeCtx: () => void
  toggleLeft: () => void
  toggleRight: () => void

  addComponent: (kind: ComponentKind, col: number, row: number) => string
  /** Add next to (near) or at the first free slot. Returns null if the canvas is full. */
  addNear: (kind: ComponentKind, near: Cell) => string | null
  moveComponent: (id: string, col: number, row: number) => void
  removeComponent: (id: string) => void
  duplicateComponent: (id: string) => void
  renameComponent: (id: string, name: string) => void
  updateConfig: (id: string, key: string, value: number) => void
  /** Several settings as one undo step (e.g. Scale up). */
  updateConfigs: (id: string, patch: Record<string, number>) => void
  addConnection: (from: string, to: string) => ConnectResult
  removeConnection: (id: string) => void
  /** Change settings on a connection (weight, backup, drain) as one undo step. */
  updateConnection: (id: string, patch: Record<string, number>) => void
  /** Add an App Servers block next to a load balancer and connect the two. Returns the new block's id. */
  addServerGroup: (lbId: string) => string | null
  undo: () => void
  redo: () => void
}

let counter = 100
const uid = (p: string) => `${p}-${++counter}`
/** Ids are handed out from a counter that restarts with the page, so skip past every id a loaded design already uses. */
function skipUsedIds(a: Architecture) {
  for (const id of [...a.components.map((c) => c.id), ...a.connections.map((c) => c.id)]) {
    const n = /-(\d+)$/.exec(id)
    if (n) counter = Math.max(counter, +n[1])
  }
}
let lastEdit = { key: '', at: 0 }

const commit = (s: UIState, architecture: Architecture) => ({ architecture, past: [...s.past, s.architecture].slice(-50), future: [] as Architecture[] })

function makeComponent(arch: Architecture, kind: ComponentKind, col: number, row: number): ArchComponent {
  const n = arch.components.filter((c) => c.kind === kind).length + 1
  const config = { ...DEFAULT_CONFIG[kind] }
  return { id: uid(kind), kind, name: n > 1 ? `${KIND_INFO[kind].label} ${n}` : KIND_INFO[kind].label, position: { col, row }, config, assumed: Object.keys(config) }
}

const startArchitecture = initialArchitecture()
skipUsedIds(startArchitecture)

export const useStore = create<UIState>((set, get) => lockEdits({
  architecture: startArchitecture,
  savedAt: null,
  past: [],
  future: [],
  selectedId: null,
  selectedConnId: null,
  dragKind: null,
  hoverCell: null,
  hoverId: null,
  ctx: null,
  pinned: null,
  review: { open: false, tab: 'review' },
  leftOpen: true,
  rightOpen: true,

  // picking something on the canvas shows its settings, even when the Challenge tab was showing
  select: (id) => { if (id) useChallenges.getState().setTab('inspector'); set((s) => ({ selectedId: id, selectedConnId: null, rightOpen: id ? true : s.rightOpen })) },
  selectConn: (id) => { if (id) useChallenges.getState().setTab('inspector'); set((s) => ({ selectedConnId: id, selectedId: null, rightOpen: id ? true : s.rightOpen })) },
  setDragKind: (dragKind) => set({ dragKind }),
  setHoverCell: (hoverCell) => set({ hoverCell }),
  setHoverId: (hoverId) => set({ hoverId }),
  openCtx: (id, x, y) => set({ ctx: { id, x, y }, selectedId: id, selectedConnId: null, hoverId: null }),
  closeCtx: () => set({ ctx: null }),
  setSavedAt: (savedAt) => set({ savedAt }),
  loadArchitecture: (arch) => {
    const s = get()
    skipUsedIds(arch)
    lastEdit = { key: '', at: 0 }
    set({ ...commit(s, arch), selectedId: null, selectedConnId: null, hoverId: null, ctx: null, pinned: null })
  },
  renameProject: (name) => set((s) => ({ architecture: { ...s.architecture, name: name.slice(0, 60) } })),
  setSlo: (patch) => set((s) => ({ architecture: { ...s.architecture, slo: { availability: 0.995, p99Ms: 500, ...s.architecture.slo, ...patch } } })),
  saveExperiment: (exp) => set((s) => {
    const list = s.architecture.experiments ?? []
    const next = list.some((e) => e.id === exp.id) ? list.map((e) => (e.id === exp.id ? exp : e)) : [...list, exp].slice(-20)
    return { architecture: { ...s.architecture, experiments: next } }
  }),
  setActual: (actual) => set((s) => {
    const { actual: _old, ...rest } = s.architecture
    return { architecture: actual && Object.keys(actual).length ? { ...rest, actual } : rest }
  }),
  deleteExperiment: (id) => set((s) => ({ architecture: { ...s.architecture, experiments: (s.architecture.experiments ?? []).filter((e) => e.id !== id) } })),
  pin: () => set((s) => ({ pinned: { arch: s.architecture, at: Date.now() } })),
  unpin: () => set({ pinned: null }),
  setReview: (open, tab) => set((s) => ({ review: { open, tab: tab ?? s.review.tab } })),
  applyArchitecture: (arch) => {
    const s = get()
    skipUsedIds(arch)
    lastEdit = { key: '', at: 0 }
    set({ ...commit(s, arch), ...pruneSelection(s, arch), pinned: s.pinned ?? { arch: s.architecture, at: Date.now() } })
  },
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),

  addComponent: (kind, col, row) => {
    const s = get()
    const c = makeComponent(s.architecture, kind, col, row)
    set({ ...commit(s, { ...s.architecture, components: [...s.architecture.components, c] }), selectedId: c.id, selectedConnId: null, rightOpen: true })
    return c.id
  },
  addNear: (kind, near) => {
    const spot = findFreeCell(get().architecture, near.col, near.row)
    return spot ? get().addComponent(kind, spot.col, spot.row) : null
  },
  moveComponent: (id, col, row) => {
    const s = get()
    set(commit(s, { ...s.architecture, components: s.architecture.components.map((c) => (c.id === id ? { ...c, position: { col, row } } : c)) }))
  },
  removeComponent: (id) => {
    const s = get()
    set({
      ...commit(s, { ...s.architecture, components: s.architecture.components.filter((c) => c.id !== id), connections: s.architecture.connections.filter((c) => c.from !== id && c.to !== id) }),
      selectedId: s.selectedId === id ? null : s.selectedId,
      selectedConnId: null,
    })
  },
  duplicateComponent: (id) => {
    const s = get()
    const src = s.architecture.components.find((c) => c.id === id)
    if (!src) return
    const spot = findFreeCell(s.architecture, src.position.col + 2, src.position.row)
    if (!spot) return
    const copy = { ...makeComponent(s.architecture, src.kind, spot.col, spot.row), config: { ...src.config }, assumed: src.assumed ? [...src.assumed] : undefined }
    set({ ...commit(s, { ...s.architecture, components: [...s.architecture.components, copy] }), selectedId: copy.id, selectedConnId: null })
  },
  renameComponent: (id, name) => {
    const s = get()
    const now = Date.now()
    const coalesce = lastEdit.key === `name:${id}` && now - lastEdit.at < 800
    lastEdit = { key: `name:${id}`, at: now }
    const architecture = { ...s.architecture, components: s.architecture.components.map((c) => (c.id === id ? { ...c, name } : c)) }
    set(coalesce ? { architecture } : commit(s, architecture))
  },
  updateConfig: (id, key, value) => {
    const s = get()
    const now = Date.now()
    const coalesce = lastEdit.key === `${id}:${key}` && now - lastEdit.at < 800
    lastEdit = { key: `${id}:${key}`, at: now }
    const architecture = {
      ...s.architecture,
      components: s.architecture.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, [key]: value }, assumed: c.assumed?.filter((k) => k !== key) } : c)),
    }
    set(coalesce ? { architecture } : commit(s, architecture))
  },
  updateConfigs: (id, patch) => {
    const s = get()
    lastEdit = { key: '', at: 0 }
    const keys = Object.keys(patch)
    set(commit(s, {
      ...s.architecture,
      components: s.architecture.components.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...patch }, assumed: c.assumed?.filter((k) => !keys.includes(k)) } : c)),
    }))
  },
  addConnection: (from, to) => {
    const s = get()
    if (from === to) return 'self'
    const cs = s.architecture.connections
    if (cs.some((c) => c.from === from && c.to === to)) return 'duplicate'
    if (cs.some((c) => c.from === to && c.to === from)) return 'reverse'
    set(commit(s, { ...s.architecture, connections: [...cs, { id: uid('conn'), from, to }] }))
    return 'ok'
  },
  updateConnection: (id, patch) => {
    const s = get()
    set(commit(s, { ...s.architecture, connections: s.architecture.connections.map((c) => (c.id === id ? { ...c, config: { ...c.config, ...patch } } : c)) }))
  },
  addServerGroup: (lbId) => {
    const s = get()
    const lb = s.architecture.components.find((c) => c.id === lbId)
    if (!lb) return null
    const targets = s.architecture.connections.filter((c) => c.from === lbId).length
    const spot = findFreeCell(s.architecture, lb.position.col + 3, lb.position.row + targets * 3 - 3) ?? findFreeCell(s.architecture, lb.position.col + 3, lb.position.row)
    if (!spot) return null
    const c = makeComponent(s.architecture, 'appServers', spot.col, spot.row)
    set({ ...commit(s, { ...s.architecture, components: [...s.architecture.components, c], connections: [...s.architecture.connections, { id: uid('conn'), from: lbId, to: c.id }] }), selectedId: c.id, selectedConnId: null, rightOpen: true })
    return c.id
  },
  removeConnection: (id) => {
    const s = get()
    set({ ...commit(s, { ...s.architecture, connections: s.architecture.connections.filter((c) => c.id !== id) }), selectedConnId: null })
  },
  undo: () => {
    const s = get()
    const prev = s.past[s.past.length - 1]
    if (!prev) return
    set({ architecture: prev, past: s.past.slice(0, -1), future: [s.architecture, ...s.future], ...pruneSelection(s, prev) })
  },
  redo: () => {
    const s = get()
    const next = s.future[0]
    if (!next) return
    set({ architecture: next, past: [...s.past, s.architecture], future: s.future.slice(1), ...pruneSelection(s, next) })
  },
}))

/** The actions that change the design. While a challenge run plays, each is refused: a run tests one fixed design. */
function lockEdits(store: UIState): UIState {
  const refuse = { addComponent: () => '', addNear: () => null, addConnection: () => 'locked', addServerGroup: () => null } as Record<string, () => unknown>
  const edits = ['addComponent', 'addNear', 'moveComponent', 'removeComponent', 'duplicateComponent', 'renameComponent', 'updateConfig', 'updateConfigs', 'addConnection', 'removeConnection', 'updateConnection', 'addServerGroup', 'undo', 'redo'] as const
  const out = store as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const name of edits) {
    const fn = out[name]
    out[name] = (...args: unknown[]) => {
      if (!runLocked()) return fn(...args)
      toast('The design is locked while the run plays', { id: 'run-locked', description: 'Stop the run to edit it.' })
      return refuse[name]?.()
    }
  }
  return store
}

function pruneSelection(s: UIState, a: Architecture) {
  return {
    selectedId: s.selectedId && a.components.some((c) => c.id === s.selectedId) ? s.selectedId : null,
    selectedConnId: s.selectedConnId && a.connections.some((c) => c.id === s.selectedConnId) ? s.selectedConnId : null,
  }
}

/** True when the components or connections changed. Renaming, or changing targets, is not a change to the design itself. */
export const designChanged = (a: Architecture, b: Architecture) => a.components !== b.components || a.connections !== b.connections
