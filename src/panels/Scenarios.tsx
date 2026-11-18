import * as Menu from '@radix-ui/react-dropdown-menu'
import { RotateCcw, X, Zap } from 'lucide-react'
import { SCENARIOS } from '../sim/scenarios'
import { useSim } from '../sim/runtime'

export function Scenarios() {
  const scenario = useSim((s) => s.scenario)
  const t = useSim((s) => s.t)
  const { startScenario, stopScenario } = useSim.getState()

  if (scenario) {
    const pending = !scenario.fired && scenario.plan.at > 0
    const eta = Math.max(0, Math.ceil(scenario.plan.at - t))
    return (
      <div className="flex items-center gap-1.5 rounded-control border border-strained/40 bg-strained/10 py-0.5 pl-2.5 pr-0.5 text-xs">
        <span className={`size-1.5 rounded-full ${pending ? 'bg-strained' : 'animate-pulse bg-failed'}`} />
        <span className="font-medium">{scenario.plan.label}</span>
        {pending && <span className="data text-dim">in {eta}s</span>}
        <button onClick={stopScenario} aria-label="Stop incident" title="Stop incident and restore" className="grid size-6 place-items-center rounded text-dim transition-colors hover:bg-line/10 hover:text-text"><X size={13} /></button>
      </div>
    )
  }

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button className="flex items-center gap-1.5 rounded-control border border-line/15 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-line/10 data-[state=open]:bg-line/10 active:scale-95">
          <Zap size={13} className="text-strained" /> <span className="hidden sm:inline">Incident</span>
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={8} className="panel z-40 w-64 p-1 shadow-lg shadow-line/10 outline-none">
          <Menu.Label className="label px-2 py-1.5">Incident: break it on purpose</Menu.Label>
          {SCENARIOS.map((s) => (
            <Menu.Item key={s.id} onSelect={() => startScenario(s.id)} className="cursor-pointer rounded-control px-2 py-2 outline-none data-[highlighted]:bg-line/10">
              <div className="font-medium">{s.label}</div>
              <div className="text-[11px] text-dim">{s.blurb}</div>
            </Menu.Item>
          ))}
          <Menu.Separator className="my-1 h-px bg-line/10" />
          <Menu.Item onSelect={() => useSim.getState().reset()} className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-dim outline-none data-[highlighted]:bg-line/10 data-[highlighted]:text-text">
            <RotateCcw size={13} /> Restore everything
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
