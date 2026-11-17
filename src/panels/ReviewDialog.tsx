import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Check, Crosshair, FileText, GitCompare, Pin, PinOff, ShieldAlert, ShieldCheck, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '../store/useStore'
import { SCENARIOS, type ScenarioId } from '../sim/scenarios'
import { runScenario, type RunSummary } from '../sim/headless'
import { suggestFixes, type Suggestion } from '../sim/fixes'
import { addParallelCopy, diffArch, findSpofs, recoveryObjectives } from '../sim/review'
import { LineChart } from './LineChart'
import { CurveChart } from './CurveChart'
import { findCapacity, type Headroom } from '../sim/finder'
import { pctLabel } from '../sim/slo'
import { compareToReality, project, type Gap } from '../sim/reality'
import { exportReport } from '../app/projectActions'

const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)
const usd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
const btn = 'flex items-center justify-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40'
const chip = (ok: boolean) => `rounded px-1.5 py-0.5 text-[10px] font-medium ${ok ? 'bg-healthy/15 text-healthy' : 'bg-failed/15 text-failed'}`

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3"><h3 className="label">{title}</h3>{hint && <span className="text-[11px] text-dim">{hint}</span>}</div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------- review tab

function StressTable({ runs }: { runs: RunSummary[] }) {
  return (
    <div className="overflow-hidden rounded-control border border-line/10">
      {runs.map((r) => (
        <div key={r.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-line/10 px-3 py-2 last:border-b-0 sm:grid-cols-[1.2fr_auto_auto_auto]">
          <div className="font-medium">{r.label}</div>
          <div className="justify-self-end sm:order-last">{r.skipped ? <span className="text-[11px] text-dim">Not applicable</span> : <span className={chip(r.passes)}>{r.passes ? 'Survives' : 'Fails'}</span>}</div>
          {r.skipped ? <div className="col-span-2 text-[11px] text-dim sm:col-span-2">{r.skipped}</div> : (
            <>
              <div className="data text-xs text-dim">peak errors <span className={r.passes ? 'text-text' : 'text-failed'}>{pct(r.peakErr)}</span></div>
              <div className="data text-xs text-dim">peak p99 <span className="text-text">{ms(r.peakP99)}</span></div>
              <div className="col-span-2 flex items-center gap-2 text-[11px] text-dim sm:order-last sm:col-span-4" title="Measured against this design's service-level targets over the 60-second run">
                <span className={chip(r.slo.meetsAvailability && r.slo.meetsLatency)}>{r.slo.meetsAvailability && r.slo.meetsLatency ? 'SLO met' : 'SLO missed'}</span>
                <span className="data">availability <span className={r.slo.meetsAvailability ? 'text-text' : 'text-failed'}>{pctLabel(r.slo.availability)}</span></span>
                <span className="data">p99 in target <span className={r.slo.meetsLatency ? 'text-text' : 'text-failed'}>{Math.round(r.slo.latencyShare * 100)}%</span> of the time</span>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function FixCard({ fix, onApply }: { fix: Suggestion; onApply: () => void }) {
  const failedBefore = fix.before.runs.filter((r) => !r.passes && !r.skipped)
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line/10 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{fix.title}</div>
        <p className="text-[12px] leading-snug text-dim">{fix.detail}</p>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {failedBefore.map((b) => {
            const a = fix.after.runs.find((r) => r.id === b.id)!
            const better = a.peakErr < b.peakErr - 0.001
            const fewer = !better && a.peakFailedNodes < b.peakFailedNodes
            const shorter = !better && !fewer && a.errSeconds < b.errSeconds - 1
            return (
              <span key={b.id} className="data text-[11px] text-dim">
                {b.label}: <span className="text-text">{pct(b.peakErr)}</span> <ArrowRight size={10} className="inline" /> <span className={a.passes ? 'text-healthy' : better || fewer || shorter ? 'text-strained' : 'text-failed'}>{pct(a.peakErr)}</span>
                {shorter && <span className="text-strained"> (errors last {b.errSeconds} s → {a.errSeconds} s)</span>}
                {fewer && <span className="text-strained"> (failing parts {b.peakFailedNodes} → {a.peakFailedNodes}, next step needed)</span>}
              </span>
            )
          })}
          <span className="data text-[11px] text-dim">cost <span className="text-text">{usd(fix.costDelta)}/hr</span></span>
        </div>
      </div>
      <button className={`${btn} shrink-0 bg-accent/10 text-accent hover:bg-accent/20`} onClick={onApply}><Wrench size={13} /> Apply</button>
    </div>
  )
}

const VERDICT: Record<Gap['verdict'], { label: string; cls: string }> = {
  close: { label: 'Close', cls: 'bg-healthy/15 text-healthy' },
  optimistic: { label: 'Model too optimistic', cls: 'bg-failed/15 text-failed' },
  pessimistic: { label: 'Model too pessimistic', cls: 'bg-strained/15 text-strained' },
}

/** Numbers measured on the real system, set beside what the model projects. */
function RealityCheck() {
  const arch = useStore((s) => s.architecture)
  const setActual = useStore((s) => s.setActual)
  const actual = useMemo(() => arch.actual ?? {}, [arch.actual])
  const proj = useMemo(() => project(arch), [arch.components, arch.connections]) // eslint-disable-line react-hooks/exhaustive-deps
  const gaps = useMemo(() => compareToReality(arch, actual, proj), [arch, actual, proj])
  const set = (key: 'p99Ms' | 'errorPct' | 'maxRps', raw: string) => {
    const next = { ...actual }
    const v = raw.trim() === '' ? NaN : Number(raw)
    if (Number.isFinite(v) && v >= 0) next[key] = v
    else delete next[key]
    setActual(Object.keys(next).length ? next : null)
  }
  const input = 'w-28 rounded-control border border-line/20 bg-transparent px-2 py-1.5 text-xs focus:border-accent focus:outline-none'
  return (
    <Section title="Reality check" hint="Optional: what you measured on the real system">
      <div className="flex flex-wrap gap-3">
        {([['p99Ms', 'p99 latency (ms)', proj.p99Ms], ['errorPct', 'Error rate (%)', proj.errorPct], ['maxRps', 'Max requests / s', proj.maxRps]] as const).map(([key, label, model]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-[11px] text-dim">{label}</span>
            <input type="number" min={0} className={input} value={actual[key] ?? ''} placeholder={model === null ? 'n/a' : `model: ${Math.round((model as number) * 10) / 10}`} onChange={(e) => set(key, e.target.value)} aria-label={label} />
          </label>
        ))}
      </div>
      {gaps.length > 0 && (
        <div className="flex flex-col gap-2">
          {gaps.map((g) => (
            <div key={g.metric} className="flex flex-col gap-1 rounded-control border border-line/10 px-3 py-2">
              <div className="flex items-center gap-2"><span className="font-medium">{g.label}</span><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${VERDICT[g.verdict].cls}`}>{VERDICT[g.verdict].label}</span>
                <span className="data ml-auto text-xs text-dim">model {Math.round(g.projected * 10) / 10} {g.unit} · measured {Math.round(g.actual * 10) / 10} {g.unit}</span></div>
              <p className="text-[12px] leading-snug text-dim">{g.note}</p>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-dim">A gap is information: the model is small on purpose, so it can miss things your system has. Saved with the design.</p>
    </Section>
  )
}

function ReviewTab() {
  const arch = useStore((s) => s.architecture)
  const { before, fixes } = useMemo(() => suggestFixes(arch), [arch])
  const spofs = useMemo(() => findSpofs(arch), [arch])
  const recovery = useMemo(() => recoveryObjectives(arch), [arch])
  const { applyArchitecture, select, setReview } = useStore.getState()
  const survived = before.runs.filter((r) => !r.skipped && r.passes).length
  const total = before.runs.filter((r) => !r.skipped).length

  const apply = (title: string, next: typeof arch | null) => {
    if (!next) { toast("Couldn't apply that", { description: 'There is no free space on the canvas.' }); return }
    applyArchitecture(next)
    toast(`Applied: ${title}`, { description: 'One undo step. Compare it with the design before.', action: { label: 'Compare', onClick: () => setReview(true, 'compare') } })
  }

  return (
    <div className="flex flex-col gap-5">
      <Section title="Stress test" hint="Each scenario runs for 60 simulated seconds">
        <div className={`flex items-center gap-2 rounded-control px-3 py-2 ${survived === total ? 'bg-healthy/10 text-healthy' : 'bg-failed/10 text-failed'}`}>
          {survived === total ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
          <span className="font-medium">This design survives {survived} of {total} scenarios</span>
        </div>
        <StressTable runs={before.runs} />
        <p className="text-[11px] text-dim">A scenario survives when errors never exceed 2% of requests. These are the same rules as the live simulation; see docs/MODEL.md.</p>
      </Section>

      <Section title="Suggested fixes" hint="Found by trying each change and re-running the stress test">
        {before.failing.length === 0 ? (
          <div className="flex items-center gap-2 text-healthy"><Check size={15} /> Nothing to fix: every scenario survives.</div>
        ) : fixes.length === 0 ? (
          <p className="text-dim">No single change measurably helps. Try combining changes by hand, or add a parallel copy of a component.</p>
        ) : (
          <div className="flex flex-col gap-2">{fixes.map((f) => <FixCard key={f.id} fix={f} onApply={() => apply(f.title, f.arch)} />)}</div>
        )}
      </Section>

      <RealityCheck />

      {recovery.length > 0 && (
        <Section title="Recovery objectives" hint="RTO: how long writes fail. RPO: how much acknowledged data can be lost">
          <div className="overflow-hidden rounded-control border border-line/10">
            {recovery.map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 gap-y-0.5 border-b border-line/10 px-3 py-2 last:border-b-0">
                <div className="font-medium">{r.name}</div>
                <div className="data text-xs text-dim">RTO <span className={r.rtoSec === null ? 'text-failed' : 'text-text'}>{r.rtoSec === null ? 'manual' : `${r.rtoSec} s`}</span></div>
                <div className="data text-xs text-dim">RPO <span className={r.rpoSec === null ? 'text-failed' : 'text-text'}>{r.rpoSec === null ? 'everything' : r.rpoSec === 0 ? 'none' : `${r.rpoSec < 1 ? Math.round(r.rpoSec * 1000) + ' ms' : r.rpoSec + ' s'}`}</span></div>
                <p className="col-span-3 text-[11px] leading-snug text-dim">{r.note}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Single points of failure" hint="Checked without running anything">
        {spofs.length === 0 ? (
          <div className="flex items-center gap-2 text-healthy"><Check size={15} /> No single point of failure.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {spofs.map((s) => (
              <div key={s.id} className="flex flex-col gap-2 rounded-control border border-line/10 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><p className="text-[12px] leading-snug text-dim">{s.reason}</p></div>
                <div className="flex shrink-0 gap-2">
                  <button className={btn} onClick={() => { select(s.id); setReview(false) }}><Crosshair size={13} /> Show</button>
                  <button className={btn} onClick={() => apply(`parallel copy of ${s.name}`, addParallelCopy(arch, s.id))}>Add a copy</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- compare tab

function Delta({ a, b, better, fmt }: { a: number; b: number; better: 'lower' | 'higher'; fmt: (v: number) => string }) {
  const d = b - a
  if (Math.abs(d) < 1e-9) return <span className="text-dim">no change</span>
  const good = better === 'lower' ? d < 0 : d > 0
  return <span className={`data ${good ? 'text-healthy' : 'text-failed'}`}>{d > 0 ? '+' : '−'}{fmt(Math.abs(d))}</span>
}

function CompareTab() {
  const arch = useStore((s) => s.architecture)
  const pinned = useStore((s) => s.pinned)
  const { pin, unpin } = useStore.getState()
  const [scenario, setScenario] = useState<ScenarioId>('spike')
  const pinnedArch = pinned?.arch
  const A = useMemo(() => (pinnedArch ? runScenario(pinnedArch, scenario) : null), [pinnedArch, scenario])
  const B = useMemo(() => runScenario(arch, scenario), [arch, scenario])
  const changes = useMemo(() => (pinnedArch ? diffArch(pinnedArch, arch) : []), [pinnedArch, arch])

  if (!pinned || !A) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <span className="grid size-10 place-items-center rounded-full bg-accent/10 text-accent"><GitCompare size={20} /></span>
        <div className="font-semibold">Compare two designs on the same scenario</div>
        <p className="max-w-md text-dim">Pin the current design as <b>A</b>, then change it (or apply a suggested fix). Come back here to see how <b>B</b>, your current design, behaves compared with A.</p>
        <button className={`${btn} bg-accent/10 text-accent hover:bg-accent/20`} onClick={pin}><Pin size={13} /> Pin current design as A</button>
      </div>
    )
  }

  const colorA = 'var(--bp-text-dim)', colorB = 'var(--bp-accent)'
  const rows: { label: string; a: string; b: string; delta: React.ReactNode }[] = [
    { label: 'Peak error rate', a: pct(A.peakErr), b: pct(B.peakErr), delta: <Delta a={A.peakErr} b={B.peakErr} better="lower" fmt={(v) => `${(v * 100).toFixed(1)} pts`} /> },
    { label: 'Peak p99 latency', a: ms(A.peakP99), b: ms(B.peakP99), delta: <Delta a={A.peakP99} b={B.peakP99} better="lower" fmt={ms} /> },
    { label: 'Lowest throughput', a: `${Math.round(A.minThroughput)} rps`, b: `${Math.round(B.minThroughput)} rps`, delta: <Delta a={A.minThroughput} b={B.minThroughput} better="higher" fmt={(v) => `${Math.round(v)} rps`} /> },
    { label: 'Estimated cost', a: `$${A.cost.toFixed(2)}/hr`, b: `$${B.cost.toFixed(2)}/hr`, delta: <span className="data text-dim">{usd(B.cost - A.cost)}/hr</span> },
  ]

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs"><span className="label">Scenario</span>
          <select value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)} className="rounded-control border border-line/15 bg-transparent px-2 py-1 text-xs hover:border-line/30 focus:border-accent focus:outline-none [&>option]:bg-surface">
            {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <span className="ml-auto flex gap-2">
          <button className={btn} onClick={pin} title="Use the current design as the new A"><Pin size={13} /> Pin current as A</button>
          <button className={btn} onClick={unpin}><PinOff size={13} /> Clear A</button>
        </span>
      </div>

      {(A.skipped || B.skipped) && <p className="text-dim">{A.skipped ?? B.skipped} This scenario cannot run on one of the designs.</p>}

      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 gap-y-0 overflow-hidden rounded-control border border-line/10 text-[13px]">
        <div className="contents text-[11px]">
          <div className="border-b border-line/10 px-3 py-2 label">Metric</div>
          <div className="border-b border-line/10 px-3 py-2 text-right"><span className="label">A · pinned</span></div>
          <div className="border-b border-line/10 px-3 py-2 text-right"><span className="label text-accent">B · current</span></div>
          <div className="border-b border-line/10 px-3 py-2 text-right label">Change</div>
        </div>
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <div className="border-b border-line/10 px-3 py-2 text-dim">{r.label}</div>
            <div className="data border-b border-line/10 px-3 py-2 text-right">{r.a}</div>
            <div className="data border-b border-line/10 px-3 py-2 text-right">{r.b}</div>
            <div className="border-b border-line/10 px-3 py-2 text-right">{r.delta}</div>
          </div>
        ))}
        <div className="px-3 py-2 text-dim">Result</div>
        <div className="px-3 py-2 text-right"><span className={chip(A.passes)}>{A.passes ? 'Survives' : 'Fails'}</span></div>
        <div className="px-3 py-2 text-right"><span className={chip(B.passes)}>{B.passes ? 'Survives' : 'Fails'}</span></div>
        <div className="px-3 py-2 text-right text-[11px] text-dim">{!A.passes && B.passes ? 'fixed' : A.passes && !B.passes ? 'regressed' : ''}</div>
      </div>

      <Section title="What changed from A to B">
        {changes.length === 0 ? <p className="text-dim">B is identical to A. Change something, or apply a suggested fix, then compare.</p> : (
          <ul className="flex flex-col gap-1">
            {changes.map((c) => (
              <li key={c.text} className="flex items-center gap-2 text-[13px]">
                <span className={`w-14 text-[10px] font-medium uppercase tracking-wide ${c.kind === 'added' ? 'text-healthy' : c.kind === 'removed' ? 'text-failed' : 'text-strained'}`}>{c.kind}</span>{c.text}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="flex flex-col gap-4">
        <LineChart title="Error rate" unit="%" faultAt={B.faultAt} yMax={5} series={[{ label: 'A', values: A.err, color: colorA, dashed: true }, { label: 'B', values: B.err, color: colorB }]} />
        <LineChart title="p99 latency" unit=" ms" faultAt={B.faultAt} yMax={500} series={[{ label: 'A', values: A.p99, color: colorA, dashed: true }, { label: 'B', values: B.p99, color: colorB }]} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- capacity tab

const fmtRps = (v: number) => Math.round(v).toLocaleString('en-US')
const fmtX = (v: number) => (!isFinite(v) ? 'idle' : v >= 100 ? '100×+' : v >= 10 ? `${v.toFixed(0)}×` : `${v.toFixed(2)}×`)

function HeadroomRow({ h, tightest }: { h: Headroom; tightest: boolean }) {
  // bar: 1× is the left edge of the "safe" zone; show up to 6× so the tight ones stand out
  const w = !isFinite(h.multiple) ? 0 : Math.min(100, (h.multiple / 6) * 100)
  const tone = h.multiple < 1.2 ? 'bg-failed' : h.multiple < 2 ? 'bg-strained' : 'bg-healthy'
  return (
    <div className="grid grid-cols-[110px_1fr_56px] items-center gap-3 py-1">
      <div className={`truncate text-[13px] ${tightest ? 'font-semibold' : ''}`} title={h.name}>{h.name}</div>
      <div className="relative h-2 rounded-full bg-line/10">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, w)}%` }} />
        <div className="absolute inset-y-[-3px] w-px bg-line/40" style={{ left: `${100 / 6}%` }} title="Today's load (1×)" />
      </div>
      <div className="data text-right text-xs">{fmtX(h.multiple)}</div>
    </div>
  )
}

function CapacityTab() {
  const arch = useStore((s) => s.architecture)
  const report = useMemo(() => findCapacity(arch), [arch])
  const setReview = useStore((s) => s.setReview)

  if (!report) {
    return <p className="py-8 text-center text-dim">Connect a Client to something first. Capacity is measured by turning its traffic up until the design breaks.</p>
  }
  const { currentRps, maxRps, multiple, capped, breaksBecause, headroom, curve } = report
  const tone = capped || multiple >= 2 ? 'healthy' : multiple >= 1.25 ? 'strained' : 'failed'
  const toneCls = { healthy: 'bg-healthy/10 text-healthy', strained: 'bg-strained/10 text-strained', failed: 'bg-failed/10 text-failed' }[tone]
  const verdict = capped ? 'Plenty of headroom' : multiple < 1 ? 'Already past its limit' : multiple < 1.25 ? 'Very little headroom' : multiple < 2 ? 'Some headroom' : 'Comfortable headroom'

  return (
    <div className="flex flex-col gap-5">
      <Section title="Where it breaks" hint="Traffic is scaled up until errors pass 2% or a component fails">
        <div className={`rounded-control px-4 py-3 ${toneCls}`}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="data text-2xl font-semibold">{capped ? `> ${fmtRps(currentRps * 64)} rps` : `${fmtRps(maxRps!)} rps`}</span>
            <span className="text-[13px]">{capped ? 'the design survives the biggest load tried' : `${fmtX(multiple)} today's ${fmtRps(currentRps)} rps`}</span>
            <span className="ml-auto rounded bg-surface/70 px-1.5 py-0.5 text-[11px] font-medium">{verdict}</span>
          </div>
        </div>
        {breaksBecause && (
          <div className="rounded-control border border-line/10 p-3">
            <div className="font-medium">{breaksBecause.title}</div>
            <ul className="mt-1 space-y-1 text-[12px] leading-snug text-dim">
              {breaksBecause.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}
            </ul>
            <p className="mt-2 rounded-control bg-line/[0.05] px-2 py-1.5 text-[12px] leading-snug"><span className="label mr-1.5">Try</span>{breaksBecause.hint}</p>
            <button className={`${btn} mt-2`} onClick={() => setReview(true, 'review')}><Wrench size={13} /> See suggested fixes</button>
          </div>
        )}
      </Section>

      <Section title="Headroom by component" hint="How many times today's load each part can take on its own">
        <div className="rounded-control border border-line/10 px-3 py-1.5">
          {headroom.map((h, i) => <HeadroomRow key={h.id} h={h} tightest={i === 0} />)}
        </div>
        <p className="text-[11px] text-dim">The bar's tick is today's load (1×). The component at the top gives out first.</p>
      </Section>

      <Section title="Errors as load rises" hint="Steady state at each load, after retries and autoscaling settle">
        <CurveChart
          points={curve.map((p) => ({ x: p.rps, y: p.err }))}
          marks={[
            { x: currentRps, label: 'today', color: 'var(--bp-accent)' },
            ...(maxRps ? [{ x: maxRps, label: 'limit', color: 'var(--status-failed)' }] : []),
          ]}
        />
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- dialog

export function ReviewDialog() {
  const { open, tab } = useStore((s) => s.review)
  const setReview = useStore((s) => s.setReview)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => setReview(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fade-in fixed inset-0 z-40 bg-text/20 backdrop-blur-[2px]" />
        <Dialog.Content className="panel dlg-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,760px)] w-[min(780px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none" style={{ background: 'var(--bp-surface)' }} aria-describedby={undefined}>
          <header className="flex items-center gap-3 border-b border-line/10 px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">Design review</Dialog.Title>
            <div className="flex rounded-control border border-line/15 p-0.5" role="tablist">
              {([['review', 'Review'], ['capacity', 'Capacity'], ['compare', 'Compare']] as const).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setReview(true, id)} className={`rounded px-3 py-1 text-xs transition-colors ${tab === id ? 'bg-accent/15 font-medium text-accent' : 'text-dim hover:text-text'}`}>{label}</button>
              ))}
            </div>
            <button className={`${btn} ml-auto`} onClick={exportReport} title="Download this review as a Markdown report"><FileText size={13} /> Export report</button>
            <Dialog.Close className="grid size-8 place-items-center rounded-control text-dim transition-colors hover:bg-line/10 hover:text-text" aria-label="Close"><X size={16} /></Dialog.Close>
          </header>
          <div className="overflow-y-auto px-4 py-4">{tab === 'review' ? <ReviewTab /> : tab === 'capacity' ? <CapacityTab /> : <CompareTab />}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
