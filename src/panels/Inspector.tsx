import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownToLine, ArrowUpFromLine, Copy, Trash2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '../store/useStore'
import { CONFIG_SCHEMA, KIND_INFO, configValue, type ConfigField } from '../store/types'
import { slide } from './ui'
import { Sparkline } from './Sparkline'
import { Faults } from './Faults'
import { levelOf, maxLevelOf } from '../canvas/tier'
import { useSim } from '../sim/runtime'
import { appCapacityPerInstance, dbCapacity, hourlyCost, scaleSpec, specLine } from '../sim/capacity'
import type { ArchComponent } from '../store/types'

const fmt = (f: ConfigField, v: number) => (f.pct ? `${Math.round(v * 100)}%` : `${v}${f.unit ? ` ${f.unit}` : ''}`)
const btn = 'flex items-center justify-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-35'

const HEALTH = {
  healthy: { label: 'Healthy', cls: 'bg-healthy/15 text-healthy', color: 'var(--status-healthy)' },
  strained: { label: 'Strained', cls: 'bg-strained/15 text-strained', color: 'var(--status-strained)' },
  failed: { label: 'Failed', cls: 'bg-failed/15 text-failed', color: 'var(--status-failed)' },
} as const

/** Upgrade level as a row of pips, so how far a component has been upgraded reads at a glance. */
function Level({ comp }: { comp: ArchComponent }) {
  const l = levelOf(comp), max = maxLevelOf(comp.kind)
  return (
    <div className="mt-1.5 flex items-center gap-2 px-1" title="Level comes from the settings that make this component more capable">
      <span className="label">Level {l}</span>
      <span className="flex gap-1" aria-hidden>{Array.from({ length: max }, (_, i) => <span key={i} className={`h-1.5 w-4 rounded-full transition-colors ${i < l ? 'bg-accent' : 'bg-line/15'}`} />)}</span>
      <span className="text-[11px] text-dim">of {max}</span>
    </div>
  )
}

function Live({ id }: { id: string }) {
  const n = useSim((s) => s.nodes[id])
  const util = useSim((s) => s.nodeUtil[id]) ?? []
  const kind = useStore((s) => s.architecture.components.find((c) => c.id === id)?.kind)
  if (!n || kind === 'client') return null
  const h = HEALTH[n.health]
  const row = (k: string, v: string, warn = false) => (
    <div className="flex items-center justify-between"><span className="text-dim">{k}</span><span className={`data ${warn ? 'text-failed' : ''}`}>{v}</span></div>
  )
  return (
    <div className="flex flex-col gap-1.5 border-b border-line/10 pb-3">
      <div className="flex items-center justify-between">
        <span className="label">Live</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${h.cls}`}>{n.down ? 'Down' : h.label}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-dim">Utilization</span>
        <span className="flex items-center gap-2"><Sparkline values={util} color={h.color} w={56} max={100} /><span className="data w-10 text-right">{Math.round(n.util * 100)}%</span></span>
      </div>
      {isFinite(n.capacity) && n.offered > 0 && row('Headroom', `${(n.capacity / n.offered).toFixed(2)}×`, n.capacity / n.offered < 1.2)}
      {row('Incoming', `${Math.round(n.offered)} rps`)}
      {row('Dropped', `${Math.round(n.dropped)} rps`, n.dropped > 0.01 * n.offered && n.dropped >= 1)}
      {row('Latency', `${n.latency < 1000 ? Math.round(n.latency) : (n.latency / 1000).toFixed(1) + 'k'} ms`)}
      {n.scaling && row('Instances', `${n.scaling.active} of ${n.scaling.max}`)}
      {n.scaling && n.scaling.pending > 0 && row('Starting', `+${n.scaling.pending}, ready in ${Math.ceil(n.scaling.nextReadyIn ?? 0)} s`)}
      {kind === 'queue' && row('Depth', `${Math.round(n.queueDepth)}`)}
      {kind === 'database' && row('Pool in use', `${n.poolUsed.toFixed(1)} / ${n.poolSize}`, n.poolUsed >= n.poolSize * 0.9)}
      {kind === 'cache' && row('Hit rate', `${Math.round(n.hit * 100)}%`)}
    </div>
  )
}

const fmtN = (n: number) => Math.round(n).toLocaleString()

/** Scale up / down (double or halve vCPU + RAM together) and a plain-language summary of what the settings mean. */
function Hardware({ comp }: { comp: ArchComponent }) {
  const updateConfigs = useStore((s) => s.updateConfigs)
  const hasSize = comp.kind === 'appServers' || comp.kind === 'database'
  const cost = hourlyCost(comp.kind, comp.config)
  const apply = (dir: 1 | -1) => {
    const n = scaleSpec(comp.config, dir)
    if (!n) return
    updateConfigs(comp.id, { vcpu: n.vcpu, ramGb: n.ramGb })
  }
  const canUp = hasSize && !!scaleSpec(comp.config, 1)
  const canDown = hasSize && !!scaleSpec(comp.config, -1)
  let summary: string | null = null
  if (comp.kind === 'appServers') {
    const { rps, limiter } = appCapacityPerInstance(comp.config)
    const auto = (configValue('appServers', comp.config, 'autoscale') ?? 0) >= 0.5
    const min = comp.config.instances ?? 1
    const max = Math.max(min, configValue('appServers', comp.config, 'maxInstances') ?? 8)
    summary = auto
      ? `${fmtN(rps)} rps per instance. Between ${fmtN(rps * min)} and ${fmtN(rps * max)} rps in total as it scales. Limited by ${limiter}.`
      : `${fmtN(rps)} rps per instance, ${fmtN(rps * min)} rps total. Limited by ${limiter}.`
  } else if (comp.kind === 'database') {
    const { rps, limiter } = dbCapacity(comp.config)
    summary = `${fmtN(rps)} rps capacity. Limited by ${limiter}. A bigger pool only helps while connections are the bottleneck.`
  }
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line/10 bg-line/[0.03] p-2.5">
      <div className="flex items-center justify-between">
        <span className="label shrink-0">Hardware</span>
        <span className="data truncate pl-2 text-right text-[11px] text-dim" title={specLine(comp.kind, comp.config)}>{specLine(comp.kind, comp.config)}</span>
      </div>
      {hasSize && (
        <div className="flex gap-2">
          <button className={`${btn} flex-1`} onClick={() => apply(1)} disabled={!canUp} title="Double vCPUs and memory"><ArrowUpFromLine size={13} /> Scale up</button>
          <button className={`${btn} flex-1`} onClick={() => apply(-1)} disabled={!canDown} title="Halve vCPUs and memory"><ArrowDownToLine size={13} /> Scale down</button>
        </div>
      )}
      {summary && <p className="text-[11px] leading-snug text-dim">{summary}</p>}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-dim">Estimated cost</span>
        <span className="data">~${cost.toFixed(2)}/hr <span className="text-dim">(est.)</span></span>
      </div>
    </div>
  )
}

function Field({ id, f, value, assumed, label }: { id: string; f: ConfigField; value: number; assumed: boolean; label?: string }) {
  const update = useStore((s) => s.updateConfig)
  const set = (v: number) => update(id, f.key, Math.min(f.max, Math.max(f.min, Math.round(v / f.step) * f.step)))
  const name = label ?? f.label

  if (f.toggle) {
    const on = value >= 0.5
    return (
      <div className="flex items-center justify-between border-b border-line/10 pb-3">
        <span className="text-dim">{name}</span>
        <button role="switch" aria-checked={on} aria-label={name} onClick={() => update(id, f.key, on ? 0 : 1)}
          className={`relative h-5 w-9 rounded-full border transition-colors ${on ? 'border-accent bg-accent' : 'border-line/25 bg-line/10'}`}>
          <span className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-line/10 pb-3">
      <div className="flex items-center justify-between">
        <span className="text-dim">{name}</span>
        <span className="data flex items-center gap-2">
          {assumed && <span className="rounded bg-strained/15 px-1 text-[10px] text-strained" title="Default value, not set by you">assumed</span>}
          {fmt(f, value)}
        </span>
      </div>
      <input type="range" min={f.min} max={f.max} step={f.step} value={value} onChange={(e) => set(+e.target.value)} aria-label={name} className="w-full cursor-pointer accent-accent" />
    </div>
  )
}

export function Inspector() {
  const open = useStore((s) => s.rightOpen)
  const id = useStore((s) => s.selectedId)
  const connId = useStore((s) => s.selectedConnId)
  const arch = useStore((s) => s.architecture)
  const { renameComponent, duplicateComponent, removeComponent, removeConnection, undo } = useStore.getState()
  const comp = arch.components.find((c) => c.id === id)
  const conn = arch.connections.find((c) => c.id === connId)
  const name = (cid: string) => arch.components.find((c) => c.id === cid)?.name ?? '?'

  const remove = () => {
    if (!comp) return
    removeComponent(comp.id)
    toast(`Removed ${comp.name}`, { action: { label: 'Undo', onClick: () => undo() } })
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside {...slide(1)} className="panel absolute bottom-[var(--dock)] right-3 top-[68px] z-10 hidden w-60 flex-col gap-3 overflow-auto p-3 md:flex">
          <div className="label">Inspector</div>
          <>
            {comp ? (
              <motion.div key={comp.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="flex flex-col gap-3">
                <div>
                  <input
                    value={comp.name}
                    onChange={(e) => renameComponent(comp.id, e.target.value)}
                    aria-label="Component name"
                    className="w-full rounded-control border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold hover:border-line/20 focus:border-accent focus:outline-none"
                  />
                  <div className="px-1 text-dim">{KIND_INFO[comp.kind].blurb}</div>
                  <Level comp={comp} />
                </div>
                <Live id={comp.id} />
                <Faults comp={comp} />
                <Hardware comp={comp} />
                {CONFIG_SCHEMA[comp.kind].filter((f) => !f.showIf || (configValue(comp.kind, comp.config, f.showIf) ?? 0) >= 0.5).map((f, i, all) => (
                  <div key={f.key} className="flex flex-col gap-2">
                    {f.group && f.group !== all[i - 1]?.group && <div className="label pt-1">{f.group}</div>}
                    <Field
                      id={comp.id}
                      f={f}
                      value={configValue(comp.kind, comp.config, f.key) ?? f.min}
                      assumed={!!comp.assumed?.includes(f.key)}
                      label={f.key === 'instances' && (configValue(comp.kind, comp.config, 'autoscale') ?? 0) >= 0.5 ? 'Instances (minimum)' : undefined}
                    />
                  </div>
                ))}
                <div className="flex gap-2">
                  <button className={`${btn} flex-1`} onClick={() => duplicateComponent(comp.id)}><Copy size={13} /> Duplicate</button>
                  <button className={`${btn} flex-1 text-failed`} onClick={remove}><Trash2 size={13} /> Delete</button>
                </div>
              </motion.div>
            ) : conn ? (
              <motion.div key={conn.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="flex flex-col gap-3">
                <div className="text-sm font-semibold">Connection</div>
                <div className="data text-xs text-dim">{name(conn.from)} → {name(conn.to)}</div>
                <button className={`${btn} text-failed`} onClick={() => removeConnection(conn.id)}><Unlink size={13} /> Remove connection</button>
              </motion.div>
            ) : (
              <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-dim">
                Select a component or connection. Drag a component to move it, or drag from the <span className="text-accent">+</span> handle to another component to connect.
              </motion.p>
            )}
          </>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
