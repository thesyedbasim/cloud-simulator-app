/**
 * The challenge game loop. A challenge loads a flawed design with the simulation paused (design mode). Pressing
 * Play starts a run: the challenge's incident plays out live, the design is locked, and the run is judged every
 * tick. It is lost the moment errors pass the limit (or a recovery deadline is missed) and won when the run ends
 * with every goal met. Pure goal logic lives in sim/challenges.ts; this wires it to the live simulation.
 */
import { challengeLoad, useChallenges, type Outcome } from '../store/challengeStore'
import { useStore } from '../store/useStore'
import { live, setPlayInterceptor, useSim, withChallengeControl } from '../sim/runtime'
import { CHALLENGES, evaluate, type Challenge, type Goal, type GoalResult } from '../sim/challenges'
import { PASS_ERR, RUN_SECONDS } from '../sim/headless'
import { planScenario } from '../sim/scenarios'
import { openDesign } from './projectActions'

type Dynamic = Extract<Goal, { kind: 'survive' | 'recover' }>
const clone = (c: Challenge) => JSON.parse(JSON.stringify(c.start)) as Challenge['start']
const store = () => useChallenges.getState()
const activeChallenge = () => CHALLENGES.find((c) => c.id === store().activeId)
/** The goals that play out over time. The rest (cost, recovery targets) are checked on the design itself. */
export const dynamicGoals = (ch: Challenge): Dynamic[] => ch.goals.filter((g): g is Dynamic => g.kind === 'survive' || g.kind === 'recover')

/** How long a run lasts, in simulated seconds. */
export function runSeconds(ch: Challenge): number {
  const dyn = dynamicGoals(ch)
  return dyn.length ? dyn.reduce((a, g) => a + (g.kind === 'recover' ? g.bySec : RUN_SECONDS), 0) : 20
}

let stage = 0
let stageStart = 0 // sim seconds already used by finished stages, for the countdown
/** Seconds into the whole run, across stages (the sim clock restarts at each stage). */
export const runElapsed = (simT: number) => stageStart + simT

const pause = () => { live.running = false; useSim.setState({ running: false }) }

/** Opens a challenge in design mode: its flawed design on the canvas, the simulation paused, the Challenge tab showing. */
export function startChallenge(ch: Challenge) {
  store().setPhase(null) // an earlier run must not keep the design locked
  if (!store().activeId) store().setStash(useStore.getState().architecture) // the player's own design comes back when they leave
  challengeLoad.on = true
  try { openDesign(clone(ch), `Design mode: ${ch.title}`) } finally { challengeLoad.on = false }
  store().start(ch.id)
  useStore.setState({ rightOpen: true })
  store().setOpen(false)
  pause()
}

/** The design as it was handed over, back in design mode. */
export function resetChallenge() {
  const ch = activeChallenge()
  if (!ch) return
  store().setPhase('design')
  store().setOutcome(null)
  challengeLoad.on = true
  try { openDesign(clone(ch), 'Restored the original design') } finally { challengeLoad.on = false }
  pause()
}

/** Back to design mode with the design as the player has left it. Also how a run in progress is stopped. */
export function backToDesign() {
  if (!store().activeId) return
  store().setPhase('design')
  store().setOutcome(null)
  useSim.getState().reset()
  pause()
}

/** Leaves the challenge altogether and lets the simulation run freely again. */
export function exitChallenge() {
  const mine = store().stash
  store().abandon()
  if (mine) openDesign(mine, 'Back to your design') // loaded after leaving, so it does not end anything
  else useSim.getState().reset()
  live.running = true
  useSim.setState({ running: true })
}

export function nextChallenge() {
  const i = CHALLENGES.findIndex((c) => c.id === store().activeId)
  const next = CHALLENGES[i + 1]
  if (next) startChallenge(next)
  else exitChallenge()
}

/** Press Play in design mode: lock the design and start the incident. */
export function playChallenge() {
  const ch = activeChallenge()
  if (!ch || store().phase !== 'design') return
  const arch = useStore.getState().architecture
  store().beginAttempt()
  store().setOutcome(null)
  store().setPhase('running')
  stage = 0
  stageStart = 0
  // the budget is a property of the design alone, so it is judged before anything runs
  const budget = evaluate(arch, { ...ch, goals: ch.goals.filter((g) => g.kind === 'cost') })
  if (!budget.passed) { conclude(ch, false, budget.results.find((r) => !r.ok)?.detail ?? 'Over budget.', 0, null); return }
  startStage(ch)
}

function startStage(ch: Challenge) {
  const g = dynamicGoals(ch)[stage]
  if (!g) { // nothing to happen: a calm run that checks the design as it is
    withChallengeControl(() => useSim.getState().reset())
    live.running = true
    useSim.setState({ running: true })
    return
  }
  const plan = planScenario(useStore.getState().architecture, g.scenario)
  if (plan.empty) { conclude(ch, false, `"${plan.label}" has nothing to act on in this design: ${plan.empty}`, 0, g); return }
  withChallengeControl(() => useSim.getState().startScenario(g.scenario)) // the run owns the incident, so it bypasses the lock it set
}

function conclude(ch: Challenge, won: boolean, detail: string, at: number, failed: Dynamic | null, results?: GoalResult[]) {
  // leave the running phase first: pausing updates the simulation, which would otherwise call the judge again and conclude twice
  store().setPhase(won ? 'won' : 'lost')
  pause()
  const arch = useStore.getState().architecture
  const ev = (results ?? evaluate(arch, ch).results).map((r) => (failed && r.goal === failed ? { ...r, ok: false, detail } : r))
  const outcome: Outcome = { won, detail, at, goals: ev.map((r) => ({ label: r.label, ok: r.ok, detail: r.detail })) }
  store().setOutcome(outcome)
  if (won) store().markSolved(ch.id)
}

/** A stage is over without a loss. Start the next incident, or give the final verdict from the goals themselves. */
function finishStage(ch: Challenge, simT: number) {
  stageStart += simT
  stage++
  if (stage < dynamicGoals(ch).length) { startStage(ch); return }
  const ev = evaluate(useStore.getState().architecture, ch)
  const bad = ev.results.find((r) => !r.ok)
  if (ev.passed) conclude(ch, true, 'Every goal was met.', simT, null, ev.results)
  else conclude(ch, false, bad ? bad.detail : 'A goal was not met.', simT, null, ev.results)
}

/** Judges the run on every published step of the simulation. */
function judge(s: { t: number; totals: { errorRate: number } | null }) {
  if (store().phase !== 'running' || !s.totals) return
  const ch = activeChallenge()
  if (!ch) return
  const g = dynamicGoals(ch)[stage]
  const t = s.t, err = s.totals.errorRate
  if (!g) { if (t >= 20) finishStage(ch, t); return }
  if (g.kind === 'survive') {
    if (err > PASS_ERR) { conclude(ch, false, `Errors reached ${(err * 100).toFixed(0)}%, above the ${PASS_ERR * 100}% limit, ${t.toFixed(0)} s into the run.`, runElapsed(t), g); return }
    if (t >= RUN_SECONDS) finishStage(ch, t)
  } else if (t >= g.bySec) {
    if (err * 100 >= PASS_ERR * 100) conclude(ch, false, `Still at ${(err * 100).toFixed(0)}% errors ${g.bySec} s in: it has not recovered.`, runElapsed(t), g)
    else finishStage(ch, t)
  }
}

/** Starts judging runs, and makes the Play button (and Space) start a run while a challenge is in design mode. */
export function startChallengeJudge() {
  const unsub = useSim.subscribe((s) => judge(s))
  setPlayInterceptor(() => {
    const { activeId, phase } = store()
    if (!activeId || !phase) return false
    if (phase === 'design') { playChallenge(); return true }
    if (phase === 'won' || phase === 'lost') { backToDesign(); return true }
    return false // running: pause and resume as usual
  })
  return () => { unsub(); setPlayInterceptor(null) }
}
