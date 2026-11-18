import { create } from 'zustand'
import { toast } from 'sonner'
import { designChanged, useStore } from '../store/useStore'
import { runLocked } from '../store/challengeStore'
import { accumulate, sloOf, zeroCounters, type Counters } from './slo'
import { analyze, type Insight } from './insight'
import { planScenario, type ScenarioId, type ScenarioPlan } from './scenarios'
import type { Experiment } from '../store/types'
import { faultsAt } from './chaos'
import { freshState, step, type EdgeResult, type Injected, type NodeResult, type StepResult, type TrafficShape, type Totals } from './engine'

const DT = 0.1 // sim seconds per step
const TICK_MS = 100
const HISTORY = 60

export const SPEEDS = [0.5, 1, 2, 4] as const

/**
 * A challenge run owns the incident and the traffic: while it plays, they cannot be changed by hand. The challenge
 * controller starts and stops its own incident through `withChallengeControl`.
 */
let challengeControl = false
export function withChallengeControl<T>(fn: () => T): T {
  challengeControl = true
  try { return fn() } finally { challengeControl = false }
}
const refused = () => {
  if (!runLocked() || challengeControl) return false
  toast('A challenge run is playing', { id: 'run-locked', description: 'Stop the run first to change the incident or the traffic.' })
  return true
}
/** Lets a challenge in design mode turn Play into "start the run". Return true when the press was handled. */
let playInterceptor: (() => boolean) | null = null
export const setPlayInterceptor = (f: (() => boolean) | null) => { playInterceptor = f }

/** Mutable, read directly by the canvas every frame (no React in the hot path). */
export const live: { result: StepResult | null; running: boolean; speed: number; bottleneck: string | null } = { result: null, running: true, speed: 1, bottleneck: null }

/** Half-second snapshots of the live simulation, so the timeline can rewind to any moment. */
interface Snap { t: number; res: StepResult; budget: Counters }
const SNAP_EVERY = 0.5
const SNAP_MAX = 480 // 4 simulated minutes
let snaps: Snap[] = []
let snapBucket = -1
let resumeAfterScrub = true
/** Requests, failures and latency-in-target time for this run, for the error budget. */
let counters: Counters = zeroCounters()

export interface Timeline { t0: number; t1: number; err: number[]; firstFail: number | null }
function timelineOf(): Timeline | null {
  if (snaps.length < 2) return null
  const bad = snaps.find((s) => s.res.totals.errorRate > 0.02)
  return { t0: snaps[0].t, t1: snaps[snaps.length - 1].t, err: snaps.map((s) => s.res.totals.errorRate * 100), firstFail: bad ? bad.t : null }
}

interface History { p50: number[]; p99: number[]; err: number[]; rps: number[]; cost: number[] }
const emptyHistory = (): History => ({ p50: [], p99: [], err: [], rps: [], cost: [] })

/** A chaos experiment running live: its faults are applied on its timeline as the simulation clock passes each event. */
interface ActiveExperiment { exp: Experiment; prevShape: TrafficShape }
interface ActiveScenario { plan: ScenarioPlan; fired: boolean; prevShape: TrafficShape; cleared?: boolean }

interface SimUI {
  running: boolean
  speed: number
  shape: TrafficShape
  t: number
  totals: Totals | null
  nodes: Record<string, NodeResult>
  edges: Record<string, EdgeResult>
  history: History
  nodeUtil: Record<string, number[]>
  injected: Record<string, Injected>
  insight: Insight | null
  dismissedKey: string | null
  scenario: ActiveScenario | null
  experiment: ActiveExperiment | null
  /** null = live; otherwise the sim second being viewed while rewound. */
  scrubT: number | null
  timeline: Timeline | null
  /** Error-budget accounting for this run (or for the rewound moment). */
  budget: Counters
  scrubTo: (t: number) => void
  goLive: () => void
  inject: (id: string, kind: Injected) => void
  restore: (id: string) => void
  restoreAll: () => void
  dismissInsight: () => void
  startScenario: (id: ScenarioId) => void
  startExperiment: (exp: Experiment) => void
  stopExperiment: () => void
  stopScenario: () => void
  toggle: () => void
  setSpeed: (s: number) => void
  setShape: (s: TrafficShape) => void
  reset: () => void
}

export const useSim = create<SimUI>((set, get) => ({
  running: true,
  speed: 1,
  shape: 'steady',
  t: 0,
  totals: null,
  nodes: {},
  edges: {},
  history: emptyHistory(),
  nodeUtil: {},
  injected: {},
  insight: null,
  scrubT: null,
  timeline: null,
  budget: zeroCounters(),
  scrubTo: (t) => {
    if (!snaps.length) return
    let snap = snaps[0]
    for (const sn of snaps) { if (sn.t <= t + 1e-6) snap = sn; else break }
    if (get().scrubT === null) resumeAfterScrub = get().running
    live.running = false
    live.result = snap.res
    const ins = analyze(useStore.getState().architecture, snap.res)
    live.bottleneck = ins?.nodeId ?? null
    set({ running: false, scrubT: snap.t, t: snap.t, totals: snap.res.totals, nodes: snap.res.nodes, edges: snap.res.edges, insight: ins, budget: snap.budget })
  },
  goLive: () => {
    if (get().scrubT === null) return
    live.running = resumeAfterScrub
    set({ scrubT: null, running: resumeAfterScrub })
    run(0)
    publish(false)
  },
  dismissedKey: null,
  scenario: null,
  experiment: null,
  inject: (id, kind) => { if (refused()) return; set((s) => ({ injected: { ...s.injected, [id]: kind } })) },
  restore: (id) => { if (refused()) return; set((s) => { const next = { ...s.injected }; delete next[id]; return { injected: next } }) },
  restoreAll: () => { if (refused()) return; set({ injected: {} }) },
  dismissInsight: () => set((s) => ({ dismissedKey: s.insight?.key ?? null })),
  startScenario: (id) => {
    if (refused()) return
    const plan = planScenario(useStore.getState().architecture, id)
    if (plan.empty) { toast(`Can't run "${plan.label}"`, { description: plan.empty }); return }
    const prev = get()
    // the scenario starts from a clean slate so there is a calm baseline before the fault lands
    resetSim()
    set({ injected: {}, dismissedKey: null, shape: plan.shape ?? prev.shape, scenario: { plan, fired: false, prevShape: prev.scenario?.prevShape ?? prev.shape }, experiment: null, running: true })
    live.running = true
    toast(plan.label, { description: plan.summary })
    fireIfDue()
  },
  startExperiment: (exp) => {
    if (refused()) return
    if (!exp.events.length) { toast("Can't run an empty experiment", { description: 'Add at least one event first.' }); return }
    const prev = get()
    resetSim()
    set({ injected: {}, dismissedKey: null, shape: exp.shape ?? prev.experiment?.prevShape ?? prev.shape, scenario: null, experiment: { exp, prevShape: prev.experiment?.prevShape ?? prev.shape }, running: true })
    live.running = true
    toast(`Chaos experiment: ${exp.name}`, { description: `${exp.events.length} event${exp.events.length === 1 ? '' : 's'} scheduled.` })
    applyExperiment()
  },
  stopExperiment: () => {
    if (refused()) return
    const ex = get().experiment
    if (!ex) return
    const injected = { ...get().injected }
    for (const e of ex.exp.events) delete injected[e.target]
    set({ experiment: null, injected, shape: ex.exp.shape ? ex.prevShape : get().shape, dismissedKey: null })
  },
  stopScenario: () => {
    if (refused()) return
    const sc = get().scenario
    if (!sc) return
    const injected = { ...get().injected }
    for (const id of Object.keys(sc.plan.injections)) delete injected[id]
    set({ scenario: null, injected, shape: sc.plan.shape ? sc.prevShape : get().shape, dismissedKey: null })
  },
  toggle: () => { if (playInterceptor?.()) return; if (get().scrubT !== null) { get().goLive(); return } const running = !get().running; live.running = running; set({ running }) },
  setSpeed: (speed) => { live.speed = speed; set({ speed }) },
  setShape: (shape) => { if (refused()) return; set({ shape }) },
  reset: () => { if (refused()) return; get().stopScenario(); get().stopExperiment(); resetSim() },
}))

let state = freshState()
let acc = 0
let sinceSample = 0

const push = (a: number[], v: number) => { a.push(v); if (a.length > HISTORY) a.shift() }

function run(dt: number) {
  const ui = useSim.getState()
  if (ui.scrubT !== null) return // rewound: the picture belongs to the past until we go live again
  const out = step(useStore.getState().architecture, state, dt, { shape: ui.shape, injected: ui.injected })
  state = out.state
  live.result = out.result
  if (dt > 0) counters = accumulate(counters, out.result.totals, dt, sloOf(useStore.getState().architecture))
  if (dt > 0) {
    const bucket = Math.floor(state.t / SNAP_EVERY)
    if (bucket !== snapBucket) {
      snapBucket = bucket
      snaps.push({ t: state.t, res: out.result, budget: counters })
      if (snaps.length > SNAP_MAX) snaps.shift()
    }
  }
  insightNow = analyze(useStore.getState().architecture, out.result)
  live.bottleneck = insightNow?.nodeId ?? null
  fireIfDue()
  applyExperiment()
}

/** Applies the faults a running chaos experiment has scheduled so far (only the experiment's own targets are touched). */
function applyExperiment() {
  const ex = useSim.getState().experiment
  if (!ex) return
  const want = faultsAt(ex.exp.events, state.t)
  const cur = useSim.getState().injected
  const next = { ...cur }
  for (const e of ex.exp.events) { if (want[e.target]) next[e.target] = want[e.target]; else delete next[e.target] }
  const same = Object.keys(next).length === Object.keys(cur).length && Object.keys(next).every((k) => next[k] === cur[k])
  if (!same) useSim.setState({ injected: next })
}

let insightNow: Insight | null = null

/** Lands the scenario's fault once its baseline period is over. */
function fireIfDue() {
  const sc = useSim.getState().scenario
  if (!sc) return
  if (sc.fired && !sc.cleared && sc.plan.until !== undefined && state.t >= sc.plan.until) {
    // a brief failure: the faults are lifted, and what matters now is whether the system recovers on its own
    const injected = { ...useSim.getState().injected }
    for (const id of Object.keys(sc.plan.injections)) delete injected[id]
    useSim.setState({ scenario: { ...sc, cleared: true }, injected })
    toast(`${sc.plan.label}: faults lifted`, { description: 'Watch whether the system recovers by itself.' })
    return
  }
  if (sc.fired || state.t < sc.plan.at) return
  useSim.setState({ scenario: { ...sc, fired: true }, injected: { ...useSim.getState().injected, ...sc.plan.injections } })
  if (Object.keys(sc.plan.injections).length) toast.warning(`${sc.plan.label}: fault injected`, { description: sc.plan.summary })
}

function publish(sample: boolean) {
  const r = live.result
  if (!r) return
  const cur = useSim.getState()
  if (cur.scrubT !== null) return
  const patch: Partial<SimUI> = { t: state.t, totals: r.totals, nodes: r.nodes, edges: r.edges, insight: insightNow, budget: counters }
  if (!insightNow && cur.dismissedKey) patch.dismissedKey = null
  if (sample) {
    const h: History = { p50: [...cur.history.p50], p99: [...cur.history.p99], err: [...cur.history.err], rps: [...cur.history.rps], cost: [...cur.history.cost] }
    push(h.p50, r.totals.p50); push(h.p99, r.totals.p99); push(h.err, r.totals.errorRate * 100); push(h.rps, r.totals.throughput); push(h.cost, r.totals.cost)
    const nu = { ...cur.nodeUtil }
    for (const id of Object.keys(r.nodes)) { const a = [...(nu[id] ?? [])]; push(a, r.nodes[id].util * 100); nu[id] = a }
    for (const id of Object.keys(nu)) if (!r.nodes[id]) delete nu[id]
    patch.history = h
    patch.nodeUtil = nu
    patch.timeline = timelineOf()
  }
  useSim.setState(patch)
}

export function resetSim() {
  state = freshState()
  acc = 0
  snaps = []
  snapBucket = -1
  resumeAfterScrub = true
  counters = zeroCounters()
  useSim.setState({ history: emptyHistory(), nodeUtil: {}, injected: {}, dismissedKey: null, scrubT: null, timeline: null })
  run(0)
  publish(true)
}

/** Starts the fixed-step simulation clock. Returns a stop function. */
export function startSim() {
  run(0)
  publish(true)
  const timer = setInterval(() => {
    const ui = useSim.getState()
    if (ui.running) {
      acc += ui.speed
      while (acc >= 1) { run(DT); acc -= 1 }
    }
    sinceSample += TICK_MS
    const sample = sinceSample >= 500
    if (sample) sinceSample = 0
    // panels get ~10 Hz of numbers; history samples every 500 ms
    publish(sample && ui.running)
  }, TICK_MS)
  // edits (and traffic-shape changes) refresh the picture immediately, even while paused
  // the past was a different design: editing returns to live and starts a fresh timeline
  const unsubArch = useStore.subscribe((s, p) => {
    if (s.architecture === p.architecture) return
    if (!designChanged(s.architecture, p.architecture)) { publish(false); return } // a rename or new targets: the run carries on
    useSim.getState().goLive()
    snaps = []
    snapBucket = -1
    counters = zeroCounters()
    useSim.setState({ timeline: null, budget: counters })
    run(0)
    publish(false)
  })
  const unsubSim = useSim.subscribe((s, p) => {
    if (s.shape === p.shape && s.injected === p.injected) return
    useSim.getState().goLive()
    run(0)
    publish(false)
  })
  return () => { clearInterval(timer); unsubArch(); unsubSim() }
}
