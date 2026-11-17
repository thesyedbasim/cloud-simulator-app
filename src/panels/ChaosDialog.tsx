import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { create } from 'zustand'
import { FlaskConical, Pencil, Play, Plus, Save, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '../store/useStore'
import { useSim } from '../sim/runtime'
import { SHAPES } from '../sim/engine'
import { runExperiment } from '../sim/headless'
import { describeExperiment, FAULT_LABEL, faultsFor, MAX_EVENTS, MAX_TIME } from '../sim/chaos'
import type { ChaosEvent, Experiment } from '../store/types'

const useChaos = create<{ open: boolean; set: (o: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }))

const btn = 'flex items-center justify-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40'
const field = 'rounded-control border border-line/20 bg-transparent px-2 py-1.5 text-xs focus:border-accent focus:outline-none'
const chip = (ok: boolean) => `rounded px-1.5 py-0.5 text-[10px] font-medium ${ok ? 'bg-healthy/15 text-healthy' : 'bg-failed/15 text-failed'}`
const newId = () => `exp-${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`

export function ChaosButton() {
  const running = useSim((s) => s.experiment)
  const open = useChaos((s) => s.set)
  if (running) {
    return (
      <div className="flex items-center gap-1.5 rounded-control border border-strained/40 bg-strained/10 py-0.5 pl-2.5 pr-0.5 text-xs">
        <span className="size-1.5 animate-pulse rounded-full bg-failed" />
        <span className="font-medium">{running.exp.name}</span>
        <button onClick={() => useSim.getState().stopExperiment()} aria-label="Stop experiment" title="Stop the experiment and lift its faults" className="grid size-6 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><X size={13} /></button>
      </div>
    )
  }
  return (
    <button onClick={() => open(true)} className="flex items-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-line/10 active:scale-95" title="Schedule several faults on a timeline and replay them">
      <FlaskConical size={13} className="text-accent" /> <span className="hidden lg:inline">Chaos</span>
    </button>
  )
}

function Editor({ draft, onChange, onClose }: { draft: Experiment; onChange: (e: Experiment) => void; onClose: () => void }) {
  const arch = useStore((s) => s.architecture)
  const { saveExperiment } = useStore.getState()
  const targets = arch.components
  const preview = useMemo(() => (draft.events.length ? runExperiment(arch, draft) : null), [arch, draft])
  const setEvent = (i: number, patch: Partial<ChaosEvent>) => onChange({ ...draft, events: draft.events.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  const add = () => {
    const first = targets.find((c) => c.kind !== 'client') ?? targets[0]
    if (!first) { toast('Add a component first'); return }
    const last = draft.events[draft.events.length - 1]
    onChange({ ...draft, events: [...draft.events, { at: Math.min(MAX_TIME, (last?.at ?? 0) + 10), target: first.id, action: faultsFor(first.kind)[0] }] })
  }
  const retarget = (i: number, id: string) => {
    const c = targets.find((x) => x.id === id)!
    const e = draft.events[i]
    setEvent(i, { target: id, action: e.action === 'restore' || faultsFor(c.kind).includes(e.action) ? e.action : faultsFor(c.kind)[0] })
  }
  const save = () => {
    if (!draft.events.length) { toast("Add at least one event first"); return }
    saveExperiment({ ...draft, name: draft.name.trim() || 'Untitled experiment' })
    toast('Experiment saved', { description: 'It is saved with the design, so you can replay it later.' })
    onClose()
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} min-w-0 flex-1`} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="Experiment name" aria-label="Experiment name" maxLength={60} />
        <select className={field} value={draft.shape ?? 'steady'} onChange={(e) => onChange({ ...draft, shape: e.target.value as Experiment['shape'] })} aria-label="Traffic shape">
          {SHAPES.map((s) => <option key={s.id} value={s.id}>{s.label} traffic</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        {draft.events.length === 0 && <p className="text-dim">No events yet. Each event applies a fault to a component at a moment in time, or restores it.</p>}
        {draft.events.map((e, i) => {
          const c = targets.find((x) => x.id === e.target)
          return (
            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-control border border-line/10 p-1.5">
              <span className="text-[11px] text-dim">at</span>
              <input type="number" min={0} max={MAX_TIME} step={1} className={`${field} w-16`} value={e.at} onChange={(ev) => setEvent(i, { at: Math.min(MAX_TIME, Math.max(0, Number(ev.target.value) || 0)) })} aria-label="Time in seconds" />
              <span className="text-[11px] text-dim">s</span>
              <select className={`${field} min-w-0 flex-1`} value={e.action} onChange={(ev) => setEvent(i, { action: ev.target.value as ChaosEvent['action'] })} aria-label="Fault">
                {c && faultsFor(c.kind).map((f) => <option key={f} value={f}>{FAULT_LABEL[f]}</option>)}
                <option value="restore">Restore</option>
              </select>
              <select className={`${field} min-w-0 flex-1`} value={e.target} onChange={(ev) => retarget(i, ev.target.value)} aria-label="Component">
                {targets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="grid size-7 place-items-center rounded text-dim hover:bg-line/10 hover:text-failed" onClick={() => onChange({ ...draft, events: draft.events.filter((_, j) => j !== i) })} aria-label="Remove event"><Trash2 size={13} /></button>
            </div>
          )
        })}
        <button className={`${btn} self-start`} onClick={add} disabled={draft.events.length >= MAX_EVENTS}><Plus size={13} /> Add event</button>
      </div>
      {preview && (
        <div className="flex flex-wrap items-center gap-3 rounded-control bg-line/[0.04] px-3 py-2 text-xs" aria-live="polite">
          <span className={chip(preview.passes)}>{preview.passes ? 'Survives' : 'Fails'}</span>
          <span className="data text-dim">peak errors <span className="text-text">{(preview.peakErr * 100).toFixed(preview.peakErr < 0.1 ? 1 : 0)}%</span></span>
          <span className="data text-dim">above 2% for <span className="text-text">{preview.errSeconds} s</span></span>
          <span className="data text-dim">peak p99 <span className="text-text">{Math.round(preview.peakP99)} ms</span></span>
          <span className={chip(preview.slo.meetsAvailability && preview.slo.meetsLatency)}>{preview.slo.meetsAvailability && preview.slo.meetsLatency ? 'SLO met' : 'SLO missed'}</span>
        </div>
      )}
      <div className="flex gap-2">
        <button className={btn} onClick={save}><Save size={13} /> Save</button>
        <button className={btn} onClick={() => { useSim.getState().startExperiment(draft); useChaos.getState().set(false) }} disabled={!draft.events.length}><Play size={13} /> Run live</button>
        <button className={`${btn} ml-auto`} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

export function ChaosDialog() {
  const open = useChaos((s) => s.open)
  const setOpen = useChaos((s) => s.set)
  const arch = useStore((s) => s.architecture)
  const { deleteExperiment } = useStore.getState()
  const [draft, setDraft] = useState<Experiment | null>(null)
  const saved = useMemo(() => arch.experiments ?? [], [arch.experiments])
  const results = useMemo(() => (open ? Object.fromEntries(saved.map((x) => [x.id, x.events.length ? runExperiment(arch, x) : null])) : {}), [open, arch, saved])
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setDraft(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fade-in fixed inset-0 z-40 bg-text/20 backdrop-blur-[2px]" />
        <Dialog.Content className="panel dlg-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,720px)] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none" style={{ background: 'var(--bp-surface)' }} aria-describedby={undefined}>
          <header className="flex items-center gap-3 border-b border-line/10 px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">Chaos experiments</Dialog.Title>
            <span className="text-[11px] text-dim">Faults on a timeline, saved with the design</span>
            <Dialog.Close className="ml-auto grid size-8 place-items-center rounded-control text-dim transition-colors hover:bg-line/10 hover:text-text" aria-label="Close"><X size={16} /></Dialog.Close>
          </header>
          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
            {draft ? <Editor draft={draft} onChange={setDraft} onClose={() => setDraft(null)} /> : (
              <>
                {saved.length === 0 && <p className="text-dim">No experiments yet. Build one to see how the design copes with several things going wrong in sequence, then replay it after every change.</p>}
                {saved.map((x) => {
                  const r = results[x.id]
                  return (
                    <div key={x.id} className="flex flex-col gap-1.5 rounded-control border border-line/10 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{x.name}</span>
                        {r && <span className={chip(r.passes)}>{r.passes ? 'Survives' : 'Fails'}</span>}
                        {r && <span className="data text-[11px] text-dim">peak errors {(r.peakErr * 100).toFixed(r.peakErr < 0.1 ? 1 : 0)}% · above 2% for {r.errSeconds} s</span>}
                        <span className="ml-auto flex gap-1.5">
                          <button className={btn} onClick={() => { useSim.getState().startExperiment(x); setOpen(false) }}><Play size={13} /> Run</button>
                          <button className={btn} onClick={() => setDraft(x)}><Pencil size={13} /> Edit</button>
                          <button className={`${btn} text-failed`} onClick={() => deleteExperiment(x.id)} aria-label={`Delete ${x.name}`}><Trash2 size={13} /></button>
                        </span>
                      </div>
                      <ol className="list-inside list-decimal text-[11px] leading-snug text-dim">{describeExperiment(x, arch).map((l, i) => <li key={i}>{l}</li>)}</ol>
                    </div>
                  )
                })}
                <button className={`${btn} self-start`} onClick={() => setDraft({ id: newId(), name: `Experiment ${saved.length + 1}`, events: [] })}><Plus size={13} /> New experiment</button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

