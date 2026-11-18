import { Pause, Play, RotateCcw } from 'lucide-react'
import { SHAPES, type TrafficShape } from '../sim/engine'
import { SPEEDS, useSim } from '../sim/runtime'
import { iconBtn } from './ui'

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/** Play / pause, speed and the sim clock. Lives in the timeline bar, beside the scrubber it drives. */
export function Transport() {
  const running = useSim((s) => s.running)
  const speed = useSim((s) => s.speed)
  const t = useSim((s) => s.t)
  const { toggle, setSpeed } = useSim.getState()
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button onClick={toggle} aria-label={running ? 'Pause' : 'Play'} title="Play / pause (Space)"
        className="grid size-6 place-items-center rounded-control bg-accent/15 text-accent transition-colors hover:bg-accent/25 active:scale-95">
        {running ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <div className="hidden items-center rounded-control border border-line/15 p-0.5 sm:flex" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s}
            className={`data rounded px-1.5 py-px text-[11px] transition-colors ${speed === s ? 'bg-accent/20 text-accent' : 'text-dim hover:text-text'}`}>{s}×</button>
        ))}
      </div>
      <span className="data w-10 text-right text-xs text-dim" title="Simulated time">{mmss(t)}</span>
    </div>
  )
}

/** Top-bar controls that change what is simulated: traffic shape, and a full reset. */
export function SimControls() {
  const shape = useSim((s) => s.shape)
  const { setShape, reset } = useSim.getState()
  return (
    <div className="flex items-center gap-1.5">
      <button className={iconBtn} onClick={reset} aria-label="Reset simulation" title="Reset simulation"><RotateCcw size={15} /></button>
      <span className="hidden text-xs text-dim xl:inline">Traffic</span>
      <select value={shape} onChange={(e) => setShape(e.target.value as TrafficShape)} aria-label="Traffic shape"
        className="hidden rounded-control border border-line/15 bg-transparent px-2 py-1 text-xs hover:border-line/30 focus:border-accent focus:outline-none xl:block [&>option]:bg-surface">
        {SHAPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </div>
  )
}
