import { Skull, Snail, RotateCcw, Minus, Eraser, Bug, Split, Flame, Waves } from 'lucide-react'
import { useSim } from '../sim/runtime'
import type { Injected } from '../sim/engine'
import type { ArchComponent } from '../store/types'

const LABEL: Record<Injected, string> = { killed: 'Down', slow: 'Slow', lostInstance: 'Instance lost', flushed: 'Flushed', zoneLoss: 'Zone lost', bad: 'Bad release', hotKey: 'Hot key', flood: 'Flooding' }

const btn = 'flex min-w-0 items-center justify-center gap-1.5 rounded-control border border-line/15 px-2 py-1.5 text-center text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-35'

/** Break one component on purpose. Faults are simulation-only and never change the design. */
export function Faults({ comp }: { comp: ArchComponent }) {
  const fault = useSim((s) => s.injected[comp.id])
  const { inject, restore } = useSim.getState()
  if (comp.kind === 'client') {
    return (
      <div className="flex flex-col gap-2">
        {fault && <div className="flex items-center justify-between"><span className="text-dim">Active fault</span><span className="rounded bg-failed/15 px-1.5 py-0.5 text-[10px] font-medium text-failed">{LABEL[fault]}</span></div>}
        <div className="grid grid-cols-2 gap-2">
          <button className={btn} onClick={() => inject(comp.id, 'flood')} disabled={fault === 'flood'}><Waves size={13} /> Flood (8×)</button>
          <button className={btn} onClick={() => restore(comp.id)} disabled={!fault}><RotateCcw size={13} /> Restore</button>
        </div>
      </div>
    )
  }
  const canFlush = comp.kind === 'cache' || comp.kind === 'cdn'
  const canHeat = (comp.kind === 'database' && (comp.config.shards ?? 1) > 1) || (comp.kind === 'queue' && (comp.config.partitions ?? 0) > 1)
  const canBreakApp = comp.kind === 'appServers' || comp.kind === 'serverless'
  const canLose = comp.kind === 'appServers' && (comp.config.instances ?? 1) > 1
  return (
    <div className="flex flex-col gap-2">
      {fault && <div className="flex items-center justify-between"><span className="text-dim">Active fault</span><span className="rounded bg-failed/15 px-1.5 py-0.5 text-[10px] font-medium text-failed">{LABEL[fault]}</span></div>}
      <div className="grid grid-cols-2 gap-2">
        <button className={btn} onClick={() => inject(comp.id, 'killed')} disabled={fault === 'killed'}><Skull size={13} /> Kill</button>
        <button className={btn} onClick={() => inject(comp.id, 'slow')} disabled={fault === 'slow'}><Snail size={13} /> Slow</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {canFlush && <button className={btn} onClick={() => inject(comp.id, 'flushed')} disabled={fault === 'flushed'}><Eraser size={13} /> Flush</button>}
        {canLose && <button className={btn} onClick={() => inject(comp.id, 'lostInstance')} disabled={fault === 'lostInstance'}><Minus size={13} /> Lose 1 instance</button>}
        {canHeat && <button className={btn} onClick={() => inject(comp.id, 'hotKey')} disabled={fault === 'hotKey'}><Flame size={13} /> Hot key</button>}
        {comp.kind === 'appServers' && <button className={btn} onClick={() => inject(comp.id, 'zoneLoss')} disabled={fault === 'zoneLoss'}><Split size={13} /> Lose a zone</button>}
        {canBreakApp && <button className={btn} onClick={() => inject(comp.id, 'bad')} disabled={fault === 'bad'}><Bug size={13} /> Bad release</button>}
        <button className={btn} onClick={() => restore(comp.id)} disabled={!fault}><RotateCcw size={13} /> Restore</button>
      </div>
    </div>
  )
}
