import { useState } from 'react'
import { ArrowRight, Check, CircleDashed, Lightbulb, LogOut, Pencil, Play, RotateCcw, Square, Trophy, X } from 'lucide-react'
import { useChallenges } from '../store/challengeStore'
import { CHALLENGES, goalLabel, type Level } from '../sim/challenges'
import { useSim } from '../sim/runtime'
import { PASS_ERR } from '../sim/headless'
import { SCENARIOS } from '../sim/scenarios'
import { backToDesign, dynamicGoals, exitChallenge, nextChallenge, playChallenge, resetChallenge, runElapsed, runSeconds } from '../app/challengeActions'

const btn = 'flex items-center justify-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40'
const primary = 'flex items-center justify-center gap-1.5 rounded-control bg-accent/15 px-2.5 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/25 active:scale-95'
const LEVEL: Record<Level, string> = { beginner: 'bg-healthy/15 text-healthy', intermediate: 'bg-strained/15 text-strained', advanced: 'bg-failed/15 text-failed' }

const PHASE = {
  design: { label: 'Design mode', cls: 'bg-accent/15 text-accent' },
  running: { label: 'Running', cls: 'bg-strained/15 text-strained' },
  lost: { label: 'Lost', cls: 'bg-failed/15 text-failed' },
  won: { label: 'Won', cls: 'bg-healthy/15 text-healthy' },
} as const

/** Inspector / Challenge switch at the top of the right-hand panel. Only shown while a challenge is in progress. */
export function RightTabs() {
  const { activeId, tab, setTab, phase } = useChallenges()
  if (!activeId) return <div className="label">Inspector</div>
  const tabBtn = (id: 'inspector' | 'challenge', text: string) => (
    <button onClick={() => setTab(id)} aria-pressed={tab === id}
      className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${tab === id ? 'bg-accent/20 font-medium text-accent' : 'text-dim hover:text-text'}`}>
      {text}{id === 'challenge' && phase && <span className={`ml-1.5 inline-block size-1.5 rounded-full align-middle ${phase === 'lost' ? 'bg-failed' : phase === 'won' ? 'bg-healthy' : phase === 'running' ? 'animate-pulse bg-strained' : 'bg-accent'}`} />}
    </button>
  )
  return <div className="flex rounded-control border border-line/15 p-0.5" role="group" aria-label="Right panel">{tabBtn('inspector', 'Inspector')}{tabBtn('challenge', 'Challenge')}</div>
}

function Goals({ results }: { results?: { label: string; ok: boolean; detail: string }[] }) {
  const { activeId } = useChallenges()
  const ch = CHALLENGES.find((c) => c.id === activeId)
  if (!ch) return null
  const rows = results ?? ch.goals.map((g) => ({ label: goalLabel(g), ok: false, detail: '' }))
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{results ? 'Goals' : 'Objectives'}</span>
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2 rounded-control border border-line/10 px-2.5 py-2">
          {results ? (r.ok ? <Check size={14} className="mt-0.5 shrink-0 text-healthy" /> : <X size={14} className="mt-0.5 shrink-0 text-failed" />) : <CircleDashed size={14} className="mt-0.5 shrink-0 text-dim" />}
          <div className="min-w-0"><div className="text-[12px] leading-snug">{r.label}</div>{results && r.detail && <div className="mt-0.5 text-[11px] leading-snug text-dim">{r.detail}</div>}</div>
        </div>
      ))}
    </div>
  )
}

function Hints({ hints }: { hints: string[] }) {
  const [shown, setShown] = useState(0)
  return (
    <div className="flex flex-col gap-1.5">
      {hints.slice(0, shown).map((h, i) => <p key={i} className="flex gap-2 rounded-control bg-line/[0.04] px-2.5 py-2 text-[12px] leading-snug"><Lightbulb size={13} className="mt-0.5 shrink-0 text-strained" />{h}</p>)}
      {shown < hints.length && <button className={`${btn} self-start`} onClick={() => setShown(shown + 1)}><Lightbulb size={13} /> {shown === 0 ? 'Give me a hint' : 'Another hint'}</button>}
    </div>
  )
}

/** The progress of a run: time left, and the error rate against the limit that loses it. */
function RunProgress({ chId }: { chId: string }) {
  const ch = CHALLENGES.find((c) => c.id === chId)!
  const t = useSim((s) => s.t)
  const err = useSim((s) => s.totals?.errorRate ?? 0)
  const total = runSeconds(ch)
  const elapsed = Math.min(total, runElapsed(t))
  const label = SCENARIOS.find((s) => s.id === dynamicGoals(ch)[0]?.scenario)?.label
  return (
    <div className="flex flex-col gap-3 rounded-control border border-line/10 p-3">
      {label && <div className="text-[12px]"><span className="text-dim">Incident: </span><span className="font-medium">{label}</span></div>}
      <div>
        <div className="flex items-baseline justify-between"><span className="label">Time</span><span className="data text-xs">{Math.floor(elapsed)} / {total} s</span></div>
        <div className="mt-1 h-1.5 rounded-full bg-line/10"><div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${(elapsed / total) * 100}%` }} /></div>
      </div>
      <div>
        <div className="flex items-baseline justify-between"><span className="label">Errors</span><span className={`data text-xs ${err > PASS_ERR * 0.75 ? 'text-failed' : ''}`}>{(err * 100).toFixed(1)}% <span className="text-dim">of {PASS_ERR * 100}% allowed</span></span></div>
        <div className="mt-1 h-1.5 rounded-full bg-line/10"><div className={`h-full rounded-full transition-[width] duration-200 ${err > PASS_ERR * 0.75 ? 'bg-failed' : 'bg-healthy'}`} style={{ width: `${Math.min(100, (err / PASS_ERR) * 100)}%` }} /></div>
      </div>
      <p className="text-[11px] leading-snug text-dim">The design is locked while it runs. Speed it up with 2× or 4× below, or stop to edit.</p>
    </div>
  )
}

/** The Challenge tab: design mode, the run, and the verdict. */
export function ChallengePanel() {
  const { activeId, phase, outcome, attempts, solved } = useChallenges()
  const ch = CHALLENGES.find((c) => c.id === activeId)
  if (!ch || !phase) return null
  const p = PHASE[phase]
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${p.cls}`}>{p.label}</span><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LEVEL[ch.level]}`}>{ch.level}</span>{attempts > 0 && <span className="data ml-auto text-[11px] text-dim">try {attempts}</span>}</div>
        <h3 className="mt-2 text-sm font-semibold leading-snug">{ch.title}</h3>
        <p className="mt-1 text-[12px] leading-snug text-dim">{ch.story}</p>
      </div>

      {phase === 'design' && (
        <>
          <p className="flex gap-2 rounded-control bg-accent/10 px-2.5 py-2 text-[12px] leading-snug"><Pencil size={13} className="mt-0.5 shrink-0 text-accent" />The simulation is paused. Fix the design on the canvas, then press Play. The run is lost the moment errors pass {PASS_ERR * 100}%.</p>
          <Goals />
          <button className={primary} onClick={playChallenge}><Play size={14} /> Play the incident</button>
          <Hints hints={ch.hints} />
          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={resetChallenge}><RotateCcw size={13} /> Original design</button>
            <button className={btn} onClick={exitChallenge}><LogOut size={13} /> Leave</button>
          </div>
        </>
      )}

      {phase === 'running' && (
        <>
          <RunProgress chId={ch.id} />
          <Goals />
          <button className={btn} onClick={backToDesign}><Square size={13} /> Stop and edit</button>
        </>
      )}

      {phase === 'lost' && outcome && (
        <>
          <div className="flex flex-col gap-1 rounded-control border border-failed/30 bg-failed/10 p-3">
            <span className="font-medium text-failed">You lost</span>
            <p className="text-[12px] leading-snug">{outcome.detail}</p>
            <p className="text-[11px] leading-snug text-dim">The simulation is frozen where it broke. Use the timeline below to rewind, and click the red component to see why.</p>
          </div>
          <Goals results={outcome.goals} />
          <button className={primary} onClick={backToDesign}><Pencil size={14} /> Back to design</button>
          <Hints hints={ch.hints} />
          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={resetChallenge}><RotateCcw size={13} /> Original design</button>
            <button className={btn} onClick={exitChallenge}><LogOut size={13} /> Leave</button>
          </div>
        </>
      )}

      {phase === 'won' && outcome && (
        <>
          <div className="flex flex-col gap-1.5 rounded-control border border-healthy/30 bg-healthy/10 p-3">
            <span className="flex items-center gap-1.5 font-medium text-healthy"><Trophy size={15} /> You won</span>
            <p className="text-[12px] leading-snug">{outcome.detail}</p>
          </div>
          <Goals results={outcome.goals} />
          <div className="flex flex-col gap-1.5 rounded-control border border-line/10 p-3">
            <span className="label">What was really going on</span>
            <p className="text-[12px] leading-snug">{ch.rootCause}</p>
            <p className="text-[11px] text-dim">Ideas: {ch.concepts.join(' · ')}</p>
          </div>
          {CHALLENGES.findIndex((c) => c.id === ch.id) < CHALLENGES.length - 1
            ? <button className={primary} onClick={nextChallenge}><ArrowRight size={14} /> Next challenge</button>
            : <button className={primary} onClick={exitChallenge}><LogOut size={14} /> Finish</button>}
          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={backToDesign}><Pencil size={13} /> Back to design</button>
            <button className={btn} onClick={exitChallenge}><LogOut size={13} /> Leave</button>
          </div>
          <p className="text-[11px] text-dim">{solved.length} of {CHALLENGES.length} challenges solved.</p>
        </>
      )}
    </div>
  )
}

/** A small status pill on the canvas, so the mode is clear even when the right panel is closed. */
export function ChallengeBanner() {
  const { activeId, phase } = useChallenges()
  const ch = CHALLENGES.find((c) => c.id === activeId)
  if (!ch || !phase) return null
  const p = PHASE[phase]
  return (
    <div className="pointer-events-none absolute bottom-[var(--dock)] left-1/2 z-10 -translate-x-1/2">
      <div className="panel pointer-events-auto flex items-center gap-2 px-3 py-1.5 text-xs shadow-lg shadow-line/10" style={{ background: 'var(--bp-surface)' }}>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${p.cls}`}>{p.label}</span>
        <span className="max-w-[40vw] truncate font-medium">{ch.title}</span>
        <span className="hidden text-dim sm:inline">
          {phase === 'design' && '· press Play to run the incident'}
          {phase === 'running' && '· design locked'}
          {phase === 'lost' && '· back to design to try again'}
          {phase === 'won' && '· solved'}
        </span>
      </div>
    </div>
  )
}
