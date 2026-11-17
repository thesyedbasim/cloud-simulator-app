import { AnimatePresence, motion } from 'motion/react'
import { Minus, ChevronDown, ArrowDownToLine, ArrowUpFromLine, Copy, Plus, ShieldBan, Trash2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '../store/useStore'
import { CONFIG_SCHEMA, KIND_INFO, configValue, type ConfigField } from '../store/types'
import { slide } from './ui'
import { Sparkline } from './Sparkline'
import { Faults } from './Faults'
import { levelOf, maxLevelOf } from '../canvas/tier'
import { useSim } from '../sim/runtime'
import { appCapacityPerInstance, dbCapacity, FUNCTION_COLD_START_MS, functionCapacity, functionDurationMs, hourlyCost, scaleSpec, specLine } from '../sim/capacity'
import type { ArchComponent } from '../store/types'
import { CONN_FIELDS, POLICIES, connValue, lbSettings, type ConnKey, type TargetStatus } from '../sim/balance'
import { ALL_REGIONS_MASK, canGeoBlock, CLIENT_TYPES, describeGeo, geoMaskOf, geoModeOf, regionOf, REGIONS, GEO_ALLOW, GEO_BLOCK, GEO_OFF } from '../sim/geo'

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
      {n.blocked >= 0.5 && row('Blocked by geo rule', `${Math.round(n.blocked)} rps`)}
      {row('Dropped', `${Math.round(n.dropped)} rps`, n.dropped > 0.01 * n.offered && n.dropped >= 1)}
      {row('Latency', `${n.latency < 1000 ? Math.round(n.latency) : (n.latency / 1000).toFixed(1) + 'k'} ms`)}
      {n.scaling && row('Instances', `${n.scaling.active} of ${n.scaling.max}`)}
      {n.scaling && n.scaling.pending > 0 && row('Starting', `+${n.scaling.pending}, ready in ${Math.ceil(n.scaling.nextReadyIn ?? 0)} s`)}
      {kind === 'queue' && row('Depth', `${Math.round(n.queueDepth)}`)}
      {kind === 'database' && n.conns && n.conns.demand >= 1 && row(n.conns.pooled ? 'Function connections (shared)' : 'Function connections', `${Math.round(n.conns.demand)}${n.conns.pooled ? '' : ` of ${n.conns.max}`}`, !n.conns.pooled && n.conns.demand > n.conns.max)}
      {kind === 'database' && n.shards && row('Busiest shard', `${Math.round(n.shards.hot * 100)}% of traffic (${n.shards.count} shards)`, n.shards.hot > n.shards.even * 1.3)}
      {kind === 'queue' && n.broker && row('Partitions in use', `${n.broker.active} of ${n.broker.partitions} · ${n.broker.consumers} consumers`, n.broker.idle > 0)}
      {kind === 'queue' && n.broker && n.broker.hot > 1 / n.broker.partitions * 1.3 && row('Hottest partition', `${Math.round(n.broker.hot * 100)}% of messages`, true)}
      {kind === 'queue' && n.broker && n.broker.dlqDepth >= 1 && row('Dead-lettered', `${Math.round(n.broker.dlqDepth)} messages`, true)}
      {kind === 'database' && n.lagMs !== undefined && row('Replication lag', `${n.lagMs < 1000 ? Math.round(n.lagMs) : (n.lagMs / 1000).toFixed(1) + 's'}`, n.lagMs > 500)}
      {kind === 'database' && n.staleReads !== undefined && row('Reads that may be stale', `${(n.staleReads * 100).toFixed(1)}%`, n.staleReads > 0.1)}
      {kind === 'database' && n.failover && row(n.failover.phase === 'failing' ? 'Failover' : 'Promoted replica', n.failover.phase === 'failing' ? `writes fail, ${Math.ceil(n.failover.remainingSec)} s left` : `${Math.round(n.failover.lostWrites)} writes/s lost`, true)}
      {kind === 'database' && row('Pool in use', `${n.poolUsed.toFixed(1)} / ${n.poolSize}`, n.poolUsed >= n.poolSize * 0.9)}
      {kind === 'serverless' && row('Running now', `${n.concurrency?.toFixed(0) ?? 0} of ${useStore.getState().architecture.components.find((c) => c.id === id)?.config.concurrency ?? 1000}`, n.util >= 0.9)}
      {kind === 'serverless' && row('Cold starts', `${Math.round((n.cold ?? 0) * 100)}% of requests`, (n.cold ?? 0) > 0.05)}
      {(kind === 'cache' || kind === 'cdn') && row('Hit rate', `${Math.round(n.hit * 100)}%`)}
      {(kind === 'cache' || kind === 'cdn') && n.warmth !== undefined && n.warmth < 0.99 && row('Warmth', `${Math.round(n.warmth * 100)}%`, n.warmth < 0.5)}
      {(kind === 'cache' || kind === 'cdn') && n.stampede !== undefined && n.stampede > 1.05 && row('Miss amplification', `${n.stampede.toFixed(1)}×`, true)}
      {n.breaker && n.breaker !== 'closed' && row('Circuit breaker', n.breaker === 'open' ? 'open: failing fast' : 'testing', true)}
    </div>
  )
}

const select = 'w-full rounded-control border border-line/20 bg-transparent px-2 py-1.5 text-xs focus:border-accent focus:outline-none'

/** Where a client's traffic comes from and what kind of client it is. */
function ClientSource({ comp }: { comp: ArchComponent }) {
  const update = useStore((s) => s.updateConfig)
  const type = Math.round(configValue('client', comp.config, 'clientType') ?? 0)
  return (
    <div className="flex flex-col gap-2 border-b border-line/10 pb-3">
      <span className="label">Traffic source</span>
      <label className="flex flex-col gap-1">
        <span className="text-dim">Region</span>
        <select className={select} value={regionOf(comp)} onChange={(e) => update(comp.id, 'region', +e.target.value)} aria-label="Region traffic comes from">
          {REGIONS.map((r, i) => <option key={r.id} value={i}>{r.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-dim">Client type</span>
        <select className={select} value={type} onChange={(e) => update(comp.id, 'clientType', +e.target.value)} aria-label="Client type">
          {CLIENT_TYPES.map((t, i) => <option key={t.id} value={i}>{t.label}</option>)}
        </select>
      </label>
    </div>
  )
}

/** Allow only, or block, a set of regions. Matching requests are turned away at this component. */
function GeoRule({ comp }: { comp: ArchComponent }) {
  const updateConfigs = useStore((s) => s.updateConfigs)
  const mode = geoModeOf(comp), mask = geoMaskOf(comp)
  const n = useSim((s) => s.nodes[comp.id])
  const setMode = (m: number) => updateConfigs(comp.id, { geoMode: m })
  const toggle = (i: number) => updateConfigs(comp.id, { geoMask: mask ^ (1 << i) })
  const modes = [{ id: GEO_OFF, label: 'Off' }, { id: GEO_ALLOW, label: 'Allow only' }, { id: GEO_BLOCK, label: 'Block' }]
  const cost = comp.kind !== 'appServers' ? 'Rejected at the edge, almost free.' : 'Rejected here, but each one still costs some CPU. Block it earlier if you can.'
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line/10 bg-line/[0.03] p-2.5">
      <div className="flex items-center justify-between">
        <span className="label flex items-center gap-1.5"><ShieldBan size={12} /> Geo rule</span>
        {n && n.blocked >= 0.5 && <span className="data text-[11px] text-dim">{Math.round(n.blocked)} rps blocked</span>}
      </div>
      <div role="radiogroup" aria-label="Geo rule mode" className="grid grid-cols-3 gap-1">
        {modes.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
            className={`rounded-control border px-1 py-1 text-[11px] transition-colors ${mode === m.id ? 'border-accent bg-accent/15 text-text' : 'border-line/15 text-dim hover:bg-line/10'}`}>{m.label}</button>
        ))}
      </div>
      {mode !== GEO_OFF && (
        <>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            {REGIONS.map((r, i) => (
              <label key={r.id} className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input type="checkbox" aria-label={r.label} className="accent-accent" checked={(mask & (1 << i)) !== 0} onChange={() => toggle(i)} /> {r.label}
              </label>
            ))}
          </div>
          <div className="flex gap-2 text-[11px]">
            <button className="text-accent hover:underline" onClick={() => updateConfigs(comp.id, { geoMask: ALL_REGIONS_MASK })}>All</button>
            <button className="text-accent hover:underline" onClick={() => updateConfigs(comp.id, { geoMask: 0 })}>None</button>
          </div>
          <p className="text-[11px] leading-snug text-dim">{describeGeo(comp)}. {cost} Blocked requests are not counted as errors.</p>
        </>
      )}
    </div>
  )
}

const STATUS: Record<TargetStatus, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-healthy/15 text-healthy' },
  warming: { label: 'Warming up', cls: 'bg-strained/15 text-strained' },
  standby: { label: 'Standby', cls: 'bg-line/10 text-dim' },
  draining: { label: 'Draining', cls: 'bg-strained/15 text-strained' },
  drained: { label: 'Drained', cls: 'bg-line/10 text-dim' },
  unhealthy: { label: 'Removed', cls: 'bg-failed/15 text-failed' },
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${on ? 'border-accent bg-accent' : 'border-line/25 bg-line/10'}`}>
      <span className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

/** Balancing policy, a per-target traffic view, and a shortcut to add another server group. */
function Balancer({ comp }: { comp: ArchComponent }) {
  const updateConfig = useStore((s) => s.updateConfig)
  const addServerGroup = useStore((s) => s.addServerGroup)
  const arch = useStore((s) => s.architecture)
  const edges = useSim((s) => s.edges)
  const nodes = useSim((s) => s.nodes)
  const s = lbSettings(comp)
  const outs = arch.connections.filter((c) => c.from === comp.id)
  const caps = outs.map((e) => { const n = nodes[e.to]; return n && isFinite(n.capacity) ? n.capacity : 0 })
  const capTotal = caps.reduce((a, b) => a + b, 0)
  const policy = POLICIES[s.policy]
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line/10 bg-line/[0.03] p-2.5">
      <span className="label">Balancing</span>
      <select className={select} value={s.policy} onChange={(e) => updateConfig(comp.id, 'policy', +e.target.value)} aria-label="Balancing policy">
        {POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <p className="text-[11px] leading-snug text-dim">{policy.blurb}</p>
      {outs.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex items-center justify-between text-[10px] text-dim"><span>Traffic share</span><span className="flex items-center gap-1"><span className="inline-block h-2 w-0.5 bg-text" /> capacity share</span></div>
          {outs.map((e, i) => {
            const er = edges[e.id]
            const share = er?.lb?.share ?? 0
            const capShare = capTotal > 0 ? caps[i] / capTotal : 0
            const st = STATUS[er?.lb?.status ?? 'active']
            const target = arch.components.find((c) => c.id === e.to)
            const n = nodes[e.to]
            return (
              <button key={e.id} onClick={() => useStore.getState().selectConn(e.id)} className="flex flex-col gap-1 rounded-control px-1 py-0.5 text-left transition-colors hover:bg-line/10" title="Open this connection's settings">
                <span className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate font-medium">{target?.name ?? '?'}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                </span>
                <span className="relative h-2 rounded-full bg-line/10">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(share * 100)}%` }} />
                  {capTotal > 0 && <span className="absolute -inset-y-0.5 w-0.5 bg-text" style={{ left: `calc(${Math.round(capShare * 100)}% - 1px)` }} />}
                </span>
                <span className="data flex justify-between text-[10px] text-dim"><span>{Math.round(share * 100)}% of traffic · {Math.round(er?.rps ?? 0)} rps</span><span className={n && n.util >= 1 ? 'text-failed' : ''}>{n ? `${Math.round(n.util * 100)}% load` : ''}</span></span>
              </button>
            )
          })}
        </div>
      )}
      <button className={btn} onClick={() => { if (!addServerGroup(comp.id)) toast('No room next to the load balancer') }}><Plus size={13} /> Add server group</button>
    </div>
  )
}

/** Settings for one connection. Only a connection that leaves a load balancer has any. */
function ConnectionSettings({ id }: { id: string }) {
  const arch = useStore((s) => s.architecture)
  const update = useStore((s) => s.updateConnection)
  const er = useSim((s) => s.edges[id])
  const conn = arch.connections.find((c) => c.id === id)
  const from = arch.components.find((c) => c.id === conn?.from)
  if (!conn || from?.kind !== 'loadBalancer') return <p className="text-[11px] leading-snug text-dim">This connection has no settings of its own. Connections that leave a load balancer have a weight, a backup flag and a drain switch.</p>
  const policy = lbSettings(from).policy
  const st = STATUS[er?.lb?.status ?? 'active']
  const w = connValue(conn, 'weight')
  const setW = (k: ConnKey, v: number) => update(id, { [k]: v })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 border-b border-line/10 pb-3">
        <div className="flex items-center justify-between"><span className="label">Live</span><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span></div>
        <div className="flex items-center justify-between"><span className="text-dim">Traffic</span><span className="data">{Math.round(er?.rps ?? 0)} rps</span></div>
        <div className="flex items-center justify-between"><span className="text-dim">Share</span><span className="data">{Math.round((er?.lb?.share ?? 0) * 100)}%</span></div>
      </div>
      <div className="flex flex-col gap-1.5 border-b border-line/10 pb-3">
        <div className="flex items-center justify-between">
          <span className="text-dim">Weight</span>
          <span className="data">{w}{policy !== 1 && <span className="ml-1 text-[10px] text-dim">(unused)</span>}</span>
        </div>
        <StepSlider min={CONN_FIELDS.weight.min} max={CONN_FIELDS.weight.max} step={1} value={w} onChange={(v) => setW('weight', v)} label="Weight" />
        {policy !== 1 && <p className="text-[11px] leading-snug text-dim">Weights only count when the balancer is set to Weighted.</p>}
      </div>
      <div className="flex items-center justify-between border-b border-line/10 pb-3">
        <span className="flex flex-col"><span className="text-dim">Backup only</span><span className="text-[10px] text-dim">Used only when every primary is out</span></span>
        <Switch on={connValue(conn, 'backup') >= 0.5} onChange={(v) => setW('backup', v ? 1 : 0)} label="Backup only" />
      </div>
      <div className="flex items-center justify-between border-b border-line/10 pb-3">
        <span className="flex flex-col"><span className="text-dim">Draining</span><span className="text-[10px] text-dim">Stop new traffic, ease off over the drain time</span></span>
        <Switch on={connValue(conn, 'drain') >= 0.5} onChange={(v) => setW('drain', v ? 1 : 0)} label="Draining" />
      </div>
    </div>
  )
}

/** A slider with a minus button on its left and a plus button on its right, each moving it one step. */
function StepSlider({ min, max, step, value, onChange, label }: { min: number; max: number; step: number; value: number; onChange: (v: number) => void; label: string }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, +v.toFixed(6)))
  const b = 'flex size-6 shrink-0 items-center justify-center rounded-control border border-line/20 text-dim transition-colors hover:bg-line/10 hover:text-text active:scale-90 disabled:pointer-events-none disabled:opacity-30'
  return (
    <div className="flex items-center gap-1.5">
      <button className={b} onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label={`Decrease ${label}`}><Minus size={12} /></button>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} aria-label={label} className="min-w-0 flex-1 cursor-pointer accent-accent" />
      <button className={b} onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label={`Increase ${label}`}><Plus size={12} /></button>
    </div>
  )
}

/** A titled, collapsible group in the inspector. Without a title the content just sits there. */
function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group/sec flex flex-col gap-3 border-t border-line/15 pt-2.5">
      <summary className="label flex cursor-pointer list-none items-center justify-between select-none [&::-webkit-details-marker]:hidden">
        {title}<ChevronDown size={13} className="transition-transform group-open/sec:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 pt-1">{children}</div>
    </details>
  )
}

const fmtN = (n: number) => Math.round(n).toLocaleString()

/** Scale up / down (double or halve vCPU + RAM together) and a plain-language summary of what the settings mean. */
function Hardware({ comp, part }: { comp: ArchComponent; part: 'summary' | 'scale' }) {
  const updateConfigs = useStore((s) => s.updateConfigs)
  const hasSize = comp.kind === 'appServers' || comp.kind === 'database'
  const served = useSim((s) => s.nodes[comp.id]?.served ?? 0)
  const cost = hourlyCost(comp.kind, comp.kind === 'serverless' ? { ...comp.config, rps: served } : comp.config)
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
  } else if (comp.kind === 'serverless') {
    summary = `About ${Math.round(functionDurationMs(comp.config))} ms per call, up to ${fmtN(functionCapacity(comp.config))} rps at the concurrency limit. You pay per request and run time, so cost follows traffic. A new instance adds ${FUNCTION_COLD_START_MS} ms (a cold start).`
  } else if (comp.kind === 'database') {
    const { rps, limiter } = dbCapacity(comp.config)
    const r = Math.round(configValue('database', comp.config, 'replicas') ?? 0)
    summary = `${fmtN(rps)} rps capacity. Limited by ${limiter}. A bigger pool only helps while connections are the bottleneck.${r > 0 ? ` Reads are spread over the primary and ${r} replica${r === 1 ? '' : 's'}; every write still goes to the primary, so replicas help read-heavy traffic most.` : ''}`
  }
  if (part === 'scale') return hasSize ? (
    <div className="flex gap-2">
      <button className={`${btn} flex-1`} onClick={() => apply(1)} disabled={!canUp} title="Double vCPUs and memory"><ArrowUpFromLine size={13} /> Scale up</button>
      <button className={`${btn} flex-1`} onClick={() => apply(-1)} disabled={!canDown} title="Halve vCPUs and memory"><ArrowDownToLine size={13} /> Scale down</button>
    </div>
  ) : null
  return (
    <>
      <div className="flex flex-col gap-1.5 border-t border-line/15 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-dim">Spec</span>
          <span className="data truncate text-right text-[11px]" title={specLine(comp.kind, comp.config)}>{specLine(comp.kind, comp.config)}</span>
        </div>
        {summary && <p className="text-[11px] leading-snug text-dim">{summary}</p>}
        <div className="flex items-center justify-between">
          <span className="text-dim">Estimated cost</span>
          <span className="data">~${cost.toFixed(2)}/hr <span className="text-dim">(est.)</span></span>
        </div>
      </div>
    </>
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
      <StepSlider min={f.min} max={f.max} step={f.step} value={value} onChange={set} label={name} />
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
                <Hardware comp={comp} part="summary" />
                <Section title="Upgrade">
                  <Hardware comp={comp} part="scale" />
                  {CONFIG_SCHEMA[comp.kind].filter((f) => !f.hidden && (!f.showIf || (configValue(comp.kind, comp.config, f.showIf) ?? 0) >= 0.5)).map((f, i, all) => (
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
                </Section>
                {(
                  <Section title="Advanced settings" open={comp.kind === 'client' || comp.kind === 'loadBalancer'}>
                    {comp.kind === 'client' && <ClientSource comp={comp} />}
                    {comp.kind === 'loadBalancer' && <Balancer comp={comp} />}
                    {canGeoBlock(comp.kind) && <GeoRule comp={comp} />}
                    <Faults comp={comp} />
                  </Section>
                )}
                <div className="flex gap-2">
                  <button className={`${btn} flex-1`} onClick={() => duplicateComponent(comp.id)}><Copy size={13} /> Duplicate</button>
                  <button className={`${btn} flex-1 text-failed`} onClick={remove}><Trash2 size={13} /> Delete</button>
                </div>
              </motion.div>
            ) : conn ? (
              <motion.div key={conn.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="flex flex-col gap-3">
                <div className="text-sm font-semibold">Connection</div>
                <div className="data text-xs text-dim">{name(conn.from)} → {name(conn.to)}</div>
                <ConnectionSettings id={conn.id} />
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
