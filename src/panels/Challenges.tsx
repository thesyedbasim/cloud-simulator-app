import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, Check, CircleDashed, GraduationCap, Lightbulb, Play, RotateCcw, Trophy, X } from 'lucide-react'
import { useChallenges } from '../store/challengeStore'
import { CHALLENGES, goalLabel, type Challenge, type Level } from '../sim/challenges'
import { startChallenge } from '../app/challengeActions'

const btn = 'flex items-center justify-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40'
const LEVEL: Record<Level, string> = { beginner: 'bg-healthy/15 text-healthy', intermediate: 'bg-strained/15 text-strained', advanced: 'bg-failed/15 text-failed' }

export function ChallengesButton() {
  const { activeId, phase, setOpen, view } = useChallenges()
  const ch = CHALLENGES.find((c) => c.id === activeId)
  const dot = phase === 'lost' ? 'bg-failed' : phase === 'won' ? 'bg-healthy' : phase === 'running' ? 'animate-pulse bg-strained' : 'bg-accent'
  return (
    <button onClick={() => { if (ch) view(ch.id); setOpen(true) }} className="flex items-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-line/10 active:scale-95" title="Guided challenges">
      <GraduationCap size={13} className="text-accent" />
      <span className="hidden lg:inline">{ch ? 'Challenge' : 'Learn'}</span>
      {ch && phase && <span className={`size-1.5 rounded-full ${dot}`} aria-label={phase} />}
    </button>
  )
}

function List() {
  const { solved, view } = useChallenges()
  return (
    <div className="flex flex-col gap-2">
      <p className="text-dim">Each challenge opens in design mode: a design with a problem, and the simulation paused. Fix it, then press Play. The incident runs live, and you lose the moment it breaks. {solved.length} of {CHALLENGES.length} solved.</p>
      {CHALLENGES.map((c) => (
        <button key={c.id} onClick={() => view(c.id)} className="flex flex-col gap-1 rounded-control border border-line/10 p-3 text-left transition-colors hover:bg-line/5">
          <span className="flex items-center gap-2">
            <span className="font-medium">{c.title}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LEVEL[c.level]}`}>{c.level}</span>
            {c.incident && <span className="rounded bg-line/10 px-1.5 py-0.5 text-[10px] font-medium text-dim">incident</span>}
            {solved.includes(c.id) && <span className="ml-auto flex items-center gap-1 text-[11px] text-healthy"><Check size={13} /> solved</span>}
          </span>
          <span className="text-[12px] leading-snug text-dim">{c.story}</span>
        </button>
      ))}
    </div>
  )
}

function Detail({ ch }: { ch: Challenge }) {
  const { activeId, solved, view, setOpen, setTab } = useChallenges()
  const active = activeId === ch.id
  const [hints, setHints] = useState(0)
  const isSolved = solved.includes(ch.id)
  return (
    <div className="flex flex-col gap-4">
      <button className={`${btn} self-start`} onClick={() => view(null)}><ArrowLeft size={13} /> All challenges</button>
      <div>
        <div className="flex items-center gap-2"><h3 className="text-base font-semibold">{ch.title}</h3><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LEVEL[ch.level]}`}>{ch.level}</span></div>
        <p className="mt-1 leading-snug text-dim">{ch.story}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="label">Objectives</span>
        {ch.goals.map((goal, i) => (
          <div key={i} className="flex items-start gap-2 rounded-control border border-line/10 px-3 py-2">
            <CircleDashed size={15} className="mt-0.5 shrink-0 text-dim" />
            <div className="min-w-0 font-medium">{goalLabel(goal)}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={() => startChallenge(ch)}>{active ? <><RotateCcw size={13} /> Restart from the original design</> : <><Play size={13} /> Start in design mode</>}</button>
        {active && <button className={btn} onClick={() => { setTab('challenge'); setOpen(false) }}>Back to the canvas</button>}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="label">Hints</span>
        {ch.hints.slice(0, hints).map((h, i) => <p key={i} className="flex gap-2 rounded-control bg-line/[0.04] px-3 py-2 leading-snug"><Lightbulb size={14} className="mt-0.5 shrink-0 text-strained" />{h}</p>)}
        {hints < ch.hints.length && <button className={`${btn} self-start`} onClick={() => setHints(hints + 1)}><Lightbulb size={13} /> {hints === 0 ? 'Give me a hint' : 'Another hint'}</button>}
      </div>
      {isSolved && (
        <div className="flex flex-col gap-1.5 rounded-control border border-healthy/30 bg-healthy/10 p-3">
          <span className="flex items-center gap-1.5 font-medium text-healthy"><Trophy size={15} /> What was really going on</span>
          <p className="leading-snug">{ch.rootCause}</p>
          <p className="text-[11px] text-dim">Ideas: {ch.concepts.join(' · ')}</p>
        </div>
      )}
    </div>
  )
}

export function ChallengesDialog() {
  const { open, viewId, setOpen } = useChallenges()
  const ch = CHALLENGES.find((c) => c.id === viewId)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fade-in fixed inset-0 z-40 bg-text/20 backdrop-blur-[2px]" />
        <Dialog.Content className="panel dlg-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,760px)] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none" style={{ background: 'var(--bp-surface)' }} aria-describedby={undefined}>
          <header className="flex items-center gap-3 border-b border-line/10 px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">Guided challenges</Dialog.Title>
            <Dialog.Close className="ml-auto grid size-8 place-items-center rounded-control text-dim transition-colors hover:bg-line/10 hover:text-text" aria-label="Close"><X size={16} /></Dialog.Close>
          </header>
          <div className="overflow-y-auto px-4 py-4">{ch ? <Detail key={ch.id} ch={ch} /> : <List />}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
