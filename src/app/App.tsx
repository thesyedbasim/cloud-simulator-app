import { ClipboardCheck, Route, PanelLeft, PanelRight, Plus, Minus, Maximize2, Undo2, Redo2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import NumberFlow from '@number-flow/react'
import { Toaster, toast } from 'sonner'
import { CanvasView, sceneRef } from '../canvas/CanvasView'
import { useStore } from '../store/useStore'
import { useHotkeys } from 'react-hotkeys-hook'
import { Palette } from '../panels/Palette'
import { Inspector } from '../panels/Inspector'
import { iconBtn } from '../panels/ui'
import { HoverTooltip } from '../panels/Tooltip'
import { TraceCard } from '../panels/TraceCard'
import { useTrace } from '../sim/traceStore'
import { SloMeter } from '../panels/SloMeter'
import { Timeline } from '../panels/Timeline'
import { ProjectMenu } from '../panels/ProjectMenu'
import { startAutosave, openDesign, openSharedFromHash } from './projectActions'
import { PRESETS } from '../presets/index'
import { ReviewDialog } from '../panels/ReviewDialog'
import { Scenarios } from '../panels/Scenarios'
import { ChaosButton, ChaosDialog } from '../panels/ChaosDialog'
import { ChallengesButton, ChallengesDialog } from '../panels/Challenges'
import { ContextMenu } from '../panels/ContextMenu'
import { InsightCard } from '../panels/InsightCard'
import { SimControls } from '../panels/SimControls'
import { Sparkline } from '../panels/Sparkline'
import { SPEEDS, startSim, useSim } from '../sim/runtime'
import { runSuite } from '../sim/headless'

/** Opens the design review. The badge counts stress scenarios the current design fails. */
function ReviewButton() {
  const arch = useStore((s) => s.architecture)
  const failing = useMemo(() => runSuite(arch).failing.length, [arch])
  return (
    <button onClick={() => useStore.getState().setReview(true, 'review')} title="Design review: stress test, suggested fixes, compare"
      className="relative flex items-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-line/10 active:scale-95">
      <ClipboardCheck size={13} className="text-accent" /> <span className="hidden lg:inline">Review</span>
      {failing > 0 && <span className="data absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-failed px-1 text-[10px] leading-4 text-white" aria-label={`${failing} scenarios fail`}>{failing}</span>}
    </button>
  )
}

function TopBar() {
  const toggleLeft = useStore((s) => s.toggleLeft)
  const toggleRight = useStore((s) => s.toggleRight)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  return (
    <header className="panel absolute inset-x-3 top-3 z-10 flex h-12 items-center gap-3 px-3">
      <button className={iconBtn} onClick={toggleLeft} aria-label="Toggle palette"><PanelLeft size={16} /></button>
      <div className="flex items-center gap-2 font-semibold"><span className="text-accent">◇</span> CloudSim</div>
      <ProjectMenu />
      <div className="ml-auto flex items-center gap-3">
        <SimControls />
        <Scenarios />
        <ChaosButton />
        <ChallengesButton />
        <button onClick={() => useTrace.getState().start()} title="Trace one request through the system (or Shift-click a moving dot)" className="flex items-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-line/10 active:scale-95"><Route size={13} className="text-accent" /> <span className="hidden lg:inline">Trace</span></button>
        <ReviewButton />
        <span className="h-5 w-px bg-line/15" />
        <div className="flex items-center gap-1">
        <button className={iconBtn} onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)"><Undo2 size={16} /></button>
        <button className={iconBtn} onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><Redo2 size={16} /></button>
        <button className={iconBtn} onClick={toggleRight} aria-label="Toggle inspector"><PanelRight size={16} /></button>
        </div>
      </div>
    </header>
  )
}

function ZoomControls() {
  return (
    <div className="panel absolute bottom-[var(--dock)] right-3 z-20 flex flex-col p-1 md:right-[264px]" style={{ bottom: 'var(--dock)' }}>
      <button className={iconBtn} onClick={() => sceneRef.current?.zoomBy(1.25)} aria-label="Zoom in"><Plus size={16} /></button>
      <button className={iconBtn} onClick={() => sceneRef.current?.zoomBy(0.8)} aria-label="Zoom out"><Minus size={16} /></button>
      <button className={iconBtn} onClick={() => sceneRef.current?.fit()} aria-label="Fit to view"><Maximize2 size={16} /></button>
    </div>
  )
}

type Tone = 'ok' | 'warn' | 'bad'
const toneClass: Record<Tone, string> = { ok: '', warn: 'text-strained', bad: 'text-failed' }
const toneColor: Record<Tone, string> = { ok: 'var(--bp-accent)', warn: 'var(--status-strained)', bad: 'var(--status-failed)' }

function Metric({ label, tone = 'ok', spark, children }: { label: string; tone?: Tone; spark?: number[]; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="label">{label}</span>
      <span className={`data text-sm transition-colors ${toneClass[tone]}`}>{children}</span>
      {spark && <span className="hidden min-[1500px]:inline"><Sparkline values={spark} color={toneColor[tone]} /></span>}
    </div>
  )
}

function MetricsStrip() {
  const hover = useStore((s) => s.hoverCell)
  const totals = useSim((s) => s.totals)
  const h = useSim((s) => s.history)
  const p50 = totals?.p50 ?? 0, p99 = totals?.p99 ?? 0, err = (totals?.errorRate ?? 0) * 100
  const whole = { maximumFractionDigits: 0 }
  return (
    <footer className="panel absolute inset-x-3 bottom-3 z-10 flex flex-col overflow-hidden">
      <Timeline />
      <div className="flex h-10 items-center gap-6 overflow-x-auto px-4 whitespace-nowrap">
      <Metric label="p50" spark={h.p50}><NumberFlow value={p50} format={whole} /> ms</Metric>
      <Metric label="p99" tone={p99 > 1000 ? 'bad' : p99 > 400 ? 'warn' : 'ok'} spark={h.p99}><NumberFlow value={p99} format={whole} /> ms</Metric>
      <Metric label="err" tone={err > 5 ? 'bad' : err > 1 ? 'warn' : 'ok'} spark={h.err}><NumberFlow value={err} format={{ maximumFractionDigits: 1, minimumFractionDigits: 1 }} />%</Metric>
      {(totals?.blocked ?? 0) >= 0.5 && <Metric label="blocked"><NumberFlow value={totals?.blocked ?? 0} format={whole} /> rps</Metric>}
      <Metric label="rps" spark={h.rps}><NumberFlow value={totals?.throughput ?? 0} format={whole} /></Metric>
      <Metric label="cost" spark={h.cost}>~$<NumberFlow value={totals?.cost ?? 0} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />/hr <span className="text-[10px] text-dim">(est.)</span></Metric>
      <span className="ml-auto" />
      <SloMeter />
      <span className="data hidden text-xs text-dim sm:inline">{hover ? `cell ${hover.col}, ${hover.row}` : 'cell –'}</span>
      </div>
    </footer>
  )
}

/** Shown on an empty canvas so a first-time visitor always has somewhere to start. */
function EmptyState() {
  const empty = useStore((s) => s.architecture.components.length === 0)
  if (!empty) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center px-4">
      <div className="panel fade-in pointer-events-auto max-w-sm p-5 text-center" style={{ background: 'var(--bp-surface)' }}>
        <div className="text-sm font-semibold">An empty blueprint</div>
        <p className="mt-1 text-dim">Drag a component from the left, or start from a design that already has a weak point to find.</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => openDesign(p.arch, `Opened ${p.name}`)} className="rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95">{p.name}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

function useShortcuts() {
  const st = useStore.getState
  useHotkeys('delete,backspace', () => {
    const { selectedId, selectedConnId, architecture, removeComponent, removeConnection, undo } = st()
    if (selectedId) {
      const name = architecture.components.find((c) => c.id === selectedId)?.name
      removeComponent(selectedId)
      toast(`Removed ${name}`, { action: { label: 'Undo', onClick: () => undo() } })
    } else if (selectedConnId) removeConnection(selectedConnId)
  })
  useHotkeys('escape', () => {
    if (sceneRef.current?.cancelConnect()) return
    if (useTrace.getState().trace) { useTrace.getState().clear(); return }
    st().select(null)
  })
  useHotkeys('mod+d', (e) => { e.preventDefault(); const id = st().selectedId; if (id) st().duplicateComponent(id) })
  useHotkeys('mod+z', (e) => { e.preventDefault(); st().undo() })
  useHotkeys('mod+shift+z', (e) => { e.preventDefault(); st().redo() })
  useHotkeys('f', () => sceneRef.current?.fit())
  useHotkeys('space', (e) => { e.preventDefault(); useSim.getState().toggle() })
  useHotkeys('1,2,3,4', (e) => { const i = Number(e.key) - 1; if (SPEEDS[i]) useSim.getState().setSpeed(SPEEDS[i]) })
  useHotkeys('[', () => st().toggleLeft())
  useHotkeys(']', () => st().toggleRight())
}

export default function App() {
  useShortcuts()
  useEffect(() => startSim(), [])
  useEffect(() => startAutosave(), [])
  useEffect(() => {
    openSharedFromHash() // a link opened in a new tab
    window.addEventListener('hashchange', openSharedFromHash) // a link pasted into a tab that is already open
    return () => window.removeEventListener('hashchange', openSharedFromHash)
  }, [])
  return (
    <div className="relative h-full w-full">
      <CanvasView />
      <TopBar />
      <Palette />
      <Inspector />
      <ZoomControls />
      <MetricsStrip />
      <EmptyState />
      <TraceCard />
      <InsightCard />
      <ReviewDialog />
      <ChaosDialog />
      <ChallengesDialog />
      <HoverTooltip />
      <ContextMenu />
      <Toaster theme="light" position="bottom-right" offset={{ bottom: 112, right: 16 }} mobileOffset={{ bottom: 112, right: 12 }} />
    </div>
  )
}
