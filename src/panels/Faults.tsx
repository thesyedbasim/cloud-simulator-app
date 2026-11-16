import { Skull, Snail, RotateCcw, Minus } from 'lucide-react'
import { useSim } from '../sim/runtime'
import type { Injected } from '../sim/engine'
import type { ArchComponent } from '../store/types'

const LABEL: Record<Injected, string> = { killed: 'Down', slow: 'Slow', lostInstance: 'Instance lost' }

const btn = 'flex flex-1 items-center justify-center gap-1.5 rounded-control border border-line/15 px-2 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-35'

/** Break one component on purpose. Faults are simulation-only and never change the design. */
export function Faults({ comp }: { comp: ArchComponent }) {
  const fault = useSim((s) => s.injected[comp.id])
  const { inject, restore } = useSim.getState()
  if (comp.kind === 'client') return null
  const canLose = comp.kind === 'appServers' && (comp.config.instances ?? 1) > 1
  return (
    <div className="flex flex-col gap-2 border-b border-line/10 pb-3">
      <div className="flex items-center justify-between">
        <span className="label">Break it</span>
        {fault && <span className="rounded bg-failed/15 px-1.5 py-0.5 text-[10px] font-medium text-failed">{LABEL[fault]}</span>}
      </div>
      <div className="flex gap-2">
        <button className={btn} onClick={() => inject(comp.id, 'killed')} disabled={fault === 'killed'}><Skull size={13} /> Kill</button>
        <button className={btn} onClick={() => inject(comp.id, 'slow')} disabled={fault === 'slow'}><Snail size={13} /> Slow</button>
      </div>
      <div className="flex gap-2">
        {canLose && <button className={btn} onClick={() => inject(comp.id, 'lostInstance')} disabled={fault === 'lostInstance'}><Minus size={13} /> Lose 1 instance</button>}
        <button className={btn} onClick={() => restore(comp.id)} disabled={!fault}><RotateCcw size={13} /> Restore</button>
      </div>
    </div>
  )
}
