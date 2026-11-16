import * as Popover from '@radix-ui/react-popover'
import { Target } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useSim } from '../sim/runtime'
import { AVAILABILITY_OPTIONS, P99_OPTIONS, burnRate, pctLabel, sloOf, sloStatus } from '../sim/slo'

const TONE = {
  ok: { text: 'text-healthy', bar: 'bg-healthy' },
  warn: { text: 'text-strained', bar: 'bg-strained' },
  bad: { text: 'text-failed', bar: 'bg-failed' },
} as const

const used = (v: number) => (!isFinite(v) || v > 9.99 ? '>999%' : `${Math.round(v * 100)}%`)
const selectCls = 'rounded-control border border-line/15 bg-transparent px-2 py-1 text-xs hover:border-line/30 focus:border-accent focus:outline-none [&>option]:bg-surface'

/** Error budget for this run, and where the service-level targets are set. */
export function SloMeter() {
  const arch = useStore((s) => s.architecture)
  const budget = useSim((s) => s.budget)
  const errorRate = useSim((s) => s.totals?.errorRate ?? 0)
  const slo = sloOf(arch)
  const st = sloStatus(budget, slo)
  const burn = burnRate(errorRate, slo)
  const tone = TONE[st.level]
  const setSlo = useStore.getState().setSlo

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-2 rounded-control px-2 py-1 text-left transition-colors hover:bg-line/10 data-[state=open]:bg-line/10" aria-label="Service-level targets and error budget">
          <span className="label flex items-center gap-1"><Target size={11} /> SLO</span>
          <span className={`data text-sm transition-colors ${tone.text}`}>{pctLabel(st.availability)}</span>
          <span className="hidden items-center gap-1.5 md:flex" title="Share of the error budget this run has used">
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line/15"><span className={`block h-full rounded-full transition-[width] duration-300 ${tone.bar}`} style={{ width: `${Math.min(100, st.budgetUsed * 100)}%` }} /></span>
            <span className={`data text-[11px] ${tone.text}`}>{used(st.budgetUsed)} budget</span>
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="panel z-40 w-80 p-3 shadow-lg shadow-line/10 outline-none" style={{ background: 'var(--bp-surface)' }}>
          <div className="font-semibold">Service-level targets</div>
          <p className="mt-0.5 text-[12px] leading-snug text-dim">The error budget is the failures your target allows. Use it up and the target is missed.</p>

          <div className="mt-3 flex flex-col gap-2">
            <label className="flex items-center justify-between gap-3 text-[13px]">
              <span>Availability</span>
              <select className={selectCls} value={slo.availability} onChange={(e) => setSlo({ availability: Number(e.target.value) })}>
                {AVAILABILITY_OPTIONS.map((a) => <option key={a} value={a}>{pctLabel(a)} (1 in {Math.round(1 / (1 - a)).toLocaleString('en-US')} may fail)</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 text-[13px]">
              <span>p99 latency under</span>
              <select className={selectCls} value={slo.p99Ms} onChange={(e) => setSlo({ p99Ms: Number(e.target.value) })}>
                {P99_OPTIONS.map((p) => <option key={p} value={p}>{p >= 1000 ? `${p / 1000} s` : `${p} ms`}</option>)}
              </select>
            </label>
          </div>

          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-line/10 pt-3 text-[13px]">
            <dt className="text-dim">Availability so far</dt>
            <dd className={`data text-right ${st.meetsAvailability ? '' : 'text-failed'}`}>{(st.availability * 100).toFixed(2)}%</dd>
            <dt className="text-dim">Error budget used</dt>
            <dd className={`data text-right ${tone.text}`}>{used(st.budgetUsed)}</dd>
            <dt className="text-dim">p99 within target</dt>
            <dd className={`data text-right ${st.meetsLatency ? '' : 'text-failed'}`}>{Math.round(st.latencyShare * 100)}% of the time</dd>
            <dt className="text-dim">Burning right now</dt>
            <dd className={`data text-right ${burn > 1 ? 'text-failed' : ''}`}>{burn < 0.05 ? 'not at all' : burn > 999 ? '>999× budget rate' : `${burn.toFixed(burn >= 10 ? 0 : 1)}× budget rate`}</dd>
          </dl>
          <p className="mt-2 text-[11px] leading-snug text-dim">Counted since the run started or the design last changed. Rewind the timeline to see it as it was.</p>
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
