import { Pause, Play, RotateCcw } from 'lucide-react'
import { motion } from 'motion/react'
import { SHAPES, type TrafficShape } from '../sim/engine'
import { SPEEDS, useSim } from '../sim/runtime'
import { iconBtn } from './ui'

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

export function SimControls() {
  const running = useSim((s) => s.running)
  const speed = useSim((s) => s.speed)
  const shape = useSim((s) => s.shape)
  const t = useSim((s) => s.t)
  const { toggle, setSpeed, setShape, reset } = useSim.getState()
  return (
    <div className="flex items-center gap-1.5">
      <motion.button whileTap={{ scale: 0.92 }} onClick={toggle} aria-label={running ? 'Pause' : 'Play'} title="Play / pause (Space)"
        className="grid size-8 place-items-center rounded-control bg-accent/15 text-accent transition-colors hover:bg-accent/25">
        {running ? <Pause size={16} /> : <Play size={16} />}
      </motion.button>
      <button className={iconBtn} onClick={reset} aria-label="Reset simulation" title="Reset simulation"><RotateCcw size={15} /></button>
      <div className="hidden items-center rounded-control border border-line/15 p-0.5 lg:flex" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s}
            className={`data rounded px-1.5 py-0.5 text-xs transition-colors ${speed === s ? 'bg-accent/20 text-accent' : 'text-dim hover:text-text'}`}>{s}×</button>
        ))}
      </div>
      <select value={shape} onChange={(e) => setShape(e.target.value as TrafficShape)} aria-label="Traffic shape"
        className="hidden rounded-control border border-line/15 bg-transparent px-2 py-1 text-xs hover:border-line/30 focus:border-accent focus:outline-none sm:block [&>option]:bg-surface">
        {SHAPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <span className="data hidden w-12 text-right text-xs text-dim xl:inline" title="Simulated time">{mmss(t)}</span>
    </div>
  )
}
