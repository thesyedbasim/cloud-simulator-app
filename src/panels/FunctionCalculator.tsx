import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Calculator, X } from 'lucide-react'
import { DEFAULT_PROFILE, FUNCTION_COLD_START_MS, MB_PER_VCPU, coresOf, functionCapacity, functionCost, runOn, type RunProfile } from '../sim/capacity'
import type { ArchComponent } from '../store/types'

const MEMORIES = [128, 256, 512, 1024, 1769, 2048, 3008]
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`)
const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`)

/** What a million runs cost at this memory and run time, ignoring always-warm instances. */
const perMillion = (cfg: Record<string, number>, memoryMb: number, runMs: number) => functionCost({ ...cfg, memoryMb, avgRunMs: runMs, rps: 1e6 / 3600, provisioned: 0 })

/**
 * A what-if calculator. It changes nothing in the design: pick what a run needs (or an application of this function) and a memory size,
 * and see whether it fits, how long it takes and what it costs.
 */
export function FunctionCalculator({ comp }: { comp: ArchComponent }) {
  const cfg = comp.config
  const apps = comp.apps ?? []
  const [appId, setAppId] = useState('')
  const [custom, setCustom] = useState<RunProfile>(DEFAULT_PROFILE)
  const [mem, setMem] = useState<number | null>(null)
  const app = apps.find((a) => a.id === appId)
  const profile: RunProfile = app ? { runMs: app.runMs ?? DEFAULT_PROFILE.runMs, memoryMb: app.memoryMb ?? DEFAULT_PROFILE.memoryMb, cores: app.cores ?? DEFAULT_PROFILE.cores } : custom
  const memory = mem ?? cfg.memoryMb ?? 512
  const r = runOn(profile, memory)

  return (
    <Dialog.Root onOpenChange={(o) => { if (o) { setAppId(''); setCustom(DEFAULT_PROFILE); setMem(null) } }}>
      <Dialog.Trigger asChild>
        <button className="flex items-center justify-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs transition-colors hover:bg-line/10 active:scale-95"><Calculator size={13} /> Will it fit? Run time calculator</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fade-in fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="panel dlg-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,700px)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col outline-none" style={{ background: 'var(--bp-surface)' }}>
          <div className="flex items-center justify-between border-b border-line/10 px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">Run time calculator · {comp.name}</Dialog.Title>
            <Dialog.Close aria-label="Close" className="grid size-6 place-items-center rounded text-dim hover:bg-line/10 hover:text-text"><X size={14} /></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Check whether a run fits in the function's memory and CPU, how long it takes and what it costs. Changes nothing in the design.</Dialog.Description>
          <div className="flex flex-col gap-4 overflow-y-auto p-4">
            <p className="text-[12px] leading-snug text-dim">A what-if tool: nothing here changes your design. Say what one run needs, pick a memory size, and see if it fits. Memory also sets the CPU: {MB_PER_VCPU} MB is one vCPU.</p>

            {apps.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-dim">What runs</span>
                <select value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="Application to check"
                  className="w-full rounded-control border border-line/15 bg-transparent px-2 py-1.5 text-xs hover:border-line/30 focus:border-accent focus:outline-none [&>option]:bg-surface">
                  <option value="">A run I describe below</option>
                  {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              {([['runMs', 'Time per run', 10, 10000, 10, 'ms'], ['memoryMb', 'Memory per run', 64, 3008, 64, 'MB'], ['cores', 'Cores per run', 0.05, 3, 0.05, '']] as const).map(([k, label, min, max, step, unit]) => (
                <label key={k} className="flex flex-col gap-1.5">
                  <span className="flex items-baseline justify-between text-xs"><span className="text-dim">{label}</span><span className="data">{profile[k]} {unit}</span></span>
                  <input type="range" min={min} max={max} step={step} value={profile[k]} disabled={!!app} onChange={(e) => setCustom({ ...custom, [k]: +e.target.value })} aria-label={label} className="cursor-pointer accent-accent disabled:opacity-40" />
                </label>
              ))}
            </div>
            {app && <p className="-mt-2 text-[11px] text-dim">These come from {app.name}. Change them in its settings.</p>}

            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between text-xs"><span className="text-dim">Function memory</span><span className="data">{memory} MB · {coresOf(memory).toFixed(2)} vCPU</span></span>
              <input type="range" min={128} max={3008} step={128} value={memory} onChange={(e) => setMem(+e.target.value)} aria-label="Function memory in MB" className="cursor-pointer accent-accent" />
            </label>

            <div className={`rounded-control border p-3 ${r.oom ? 'border-failed/40 bg-failed/5' : r.slowdown > 1.05 ? 'border-strained/40 bg-strained/5' : 'border-healthy/30 bg-healthy/5'}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{r.oom ? 'Fails: not enough memory' : r.slowdown > 1.05 ? `Runs, but ${r.slowdown.toFixed(1)}× slower` : 'Fits'}</span>
                <span className="data text-lg">{r.oom ? '—' : ms(r.ms)}</span>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-[12px]">
                <div className="flex justify-between"><span className="text-dim">Memory: needs {profile.memoryMb} MB, has {memory} MB</span><span className="data">{r.oom ? 'short' : 'ok'}</span></div>
                <div className="flex justify-between"><span className="text-dim">CPU: needs {profile.cores} cores, has {coresOf(memory).toFixed(2)}</span><span className="data">{r.slowdown > 1.05 ? `×${r.slowdown.toFixed(2)} time` : 'ok'}</span></div>
                {!r.oom && <div className="flex justify-between border-t border-line/10 pt-1"><span className="text-dim">If a new instance has to start (cold start)</span><span className="data">{ms(r.ms + FUNCTION_COLD_START_MS)}</span></div>}
                {!r.oom && <div className="flex justify-between"><span className="text-dim">Most runs per second at the concurrency limit ({cfg.concurrency ?? 1000})</span><span className="data">{Math.round(functionCapacity({ ...cfg, memoryMb: memory, avgRunMs: r.ms })).toLocaleString()}</span></div>}
                {!r.oom && <div className="flex justify-between"><span className="text-dim">Cost per million runs</span><span className="data">{usd(perMillion(cfg, memory, r.ms))}</span></div>}
              </div>
            </div>

            <div>
              <div className="label mb-1.5">The same run at other memory sizes</div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-[12px]">
                <span className="text-dim">Memory</span><span className="text-right text-dim">Run time</span><span className="text-right text-dim">Per million</span>
                {MEMORIES.map((m) => {
                  const x = runOn(profile, m)
                  const current = m === (cfg.memoryMb ?? 512)
                  return (
                    <div key={m} className={`col-span-3 grid grid-cols-subgrid ${current ? 'font-medium text-accent' : ''}`}>
                      <span>{m} MB{current ? ' (current)' : ''}</span>
                      <span className={`data text-right ${x.oom ? 'text-failed' : x.slowdown > 1.05 ? 'text-strained' : ''}`}>{x.oom ? 'fails' : ms(x.ms)}</span>
                      <span className="data text-right">{x.oom ? '—' : usd(perMillion(cfg, m, x.ms))}</span>
                    </div>
                  )
                })}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-dim">More memory than a run needs does not make it faster. It only makes it fit, and costs more per second.</p>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
