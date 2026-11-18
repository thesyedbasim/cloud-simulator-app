import { useMemo } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, Route } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useTrace } from '../sim/traceStore'
import { regionOf, REGIONS } from '../sim/geo'
import type { TraceOutcomeFilter, TraceType } from '../sim/trace'

const OUTCOMES: { id: TraceOutcomeFilter; label: string; hint: string }[] = [
  { id: 'any', label: 'Any', hint: 'A typical request' },
  { id: 'ok', label: 'Succeeds', hint: 'One that gets through' },
  { id: 'fail', label: 'Fails', hint: 'One that gets rejected' },
  { id: 'slow', label: 'Slow', hint: 'Slower than 95% of requests' },
]

const TYPES: { id: TraceType; label: string; hint: string }[] = [
  { id: 'any', label: 'Typical', hint: 'No read/write rules: the plain request used before' },
  { id: 'read', label: 'Read', hint: 'Can be answered by a cache or CDN; may come from a replica' },
  { id: 'write', label: 'Write', hint: 'Skips caches and goes to the database; fails while the primary is down' },
  { id: 'upload', label: 'Upload', hint: 'A write that heads for a bucket or queue' },
]

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex rounded-control border border-line/15 p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} onClick={() => onChange(o.id)} aria-pressed={value === o.id} title={o.title}
          className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${value === o.id ? 'bg-accent/20 font-medium text-accent' : 'text-dim hover:text-text'}`}>{o.label}</button>
      ))}
    </div>
  )
}

/** Trace button: a click traces with the current settings; the chevron opens them. */
export function TraceMenu() {
  const components = useStore((s) => s.architecture.components)
  const clients = useMemo(() => components.filter((c) => c.kind === 'client'), [components])
  const opts = useTrace((s) => s.opts)
  const count = useTrace((s) => s.count)
  const { setOpts, setCount, start } = useTrace.getState()
  const custom = opts.outcome !== 'any' || opts.type !== 'any' || !!opts.from || count > 1
  const title = count > 1 ? 'Trace 100 requests and summarise them' : 'Trace one request through the system (or Shift-click a moving dot)'

  return (
    <Popover.Root>
      <div className="flex items-stretch rounded-control border border-line/15">
        <button onClick={() => start()} title={title}
          className="flex items-center gap-1.5 rounded-l-control px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-line/10 active:scale-95">
          <Route size={13} className="text-accent" /> <span className="hidden lg:inline">Trace{count > 1 ? ` ×${count}` : ''}</span>
        </button>
        <Popover.Trigger asChild>
          <button aria-label="Trace options" title="Trace options"
            className="relative grid w-6 place-items-center rounded-r-control border-l border-line/15 text-dim transition-colors hover:bg-line/10 hover:text-text data-[state=open]:bg-line/10">
            <ChevronDown size={12} />
            {custom && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}
          </button>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="panel z-40 flex w-72 flex-col gap-3 p-3 shadow-lg shadow-line/10 outline-none">
          <div>
            <div className="label mb-1.5">From</div>
            <select value={opts.from ?? ''} onChange={(e) => setOpts({ from: e.target.value || undefined })} aria-label="Client to trace from"
              className="w-full rounded-control border border-line/15 bg-transparent px-2 py-1.5 text-xs hover:border-line/30 focus:border-accent focus:outline-none [&>option]:bg-surface">
              <option value="">Any client (by traffic)</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name} · {REGIONS[regionOf(c)].label}</option>)}
            </select>
          </div>
          <div>
            <div className="label mb-1.5">Type of request</div>
            <Seg label="Request type" value={opts.type} onChange={(type) => setOpts({ type })} options={TYPES.map((o) => ({ id: o.id, label: o.label, title: o.hint }))} />
            <p className="mt-1 text-[11px] text-dim">{TYPES.find((o) => o.id === opts.type)?.hint}.</p>
          </div>
          <div>
            <div className="label mb-1.5">Request that…</div>
            <Seg label="Outcome" value={opts.outcome} onChange={(outcome) => setOpts({ outcome })} options={OUTCOMES.map((o) => ({ id: o.id, label: o.label, title: o.hint }))} />
            {count > 1 && opts.outcome !== 'any' && <p className="mt-1 text-[11px] text-dim">The outcome filter applies to single traces only.</p>}
          </div>
          <div>
            <div className="label mb-1.5">How many</div>
            <Seg label="Count" value={count} onChange={setCount} options={[{ id: 1, label: 'One, animated' }, { id: 100, label: '100, summarised' }]} />
          </div>
          <Popover.Close asChild>
            <button onClick={() => start()} className="rounded-control bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25 active:scale-95">Trace now</button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
