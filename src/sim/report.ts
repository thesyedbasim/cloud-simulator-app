/**
 * A written design review, as Markdown, built from the same checks the review tab runs. Pure and deterministic (no dates), so the
 * same design always gives the same report. Everything in it is a model estimate, and says so.
 */
import type { Architecture } from '../store/types'
import { KIND_INFO } from '../store/types'
import { runExperiment, runScenario, type RunSummary } from './headless'
import { SCENARIOS, SUITE_IDS } from './scenarios'
import { findSpofs, recoveryObjectives } from './review'
import { findCapacity } from './finder'
import { compareToReality, project } from './reality'
import { sloOf, pctLabel } from './slo'
import { step, freshState } from './engine'

const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)
/** Keeps text from breaking a table row. */
const cell = (s: string) => s.split('|').join('\\|').split('\n').join(' ')

function runRow(label: string, r: RunSummary): string {
  if (r.skipped) return `| ${cell(label)} | not applicable | | | | ${cell(r.skipped)} |`
  return `| ${cell(label)} | ${r.passes ? 'survives' : '**fails**'} | ${pct(r.peakErr)} | ${r.errSeconds} s | ${ms(r.peakP99)} | ${r.slo.meetsAvailability && r.slo.meetsLatency ? 'met' : 'missed'} |`
}

export function buildReport(arch: Architecture): string {
  const out: string[] = []
  const slo = sloOf(arch)
  const cost = step(arch, freshState(), 0, { shape: 'steady' }).result.totals.cost
  const cap = findCapacity(arch)

  out.push(`# ${arch.name}: design report`, '')
  out.push('> Everything here is an estimate from the CloudSim model (see docs/MODEL.md): it shows how a design *behaves*, and is not a load test or a prediction for production.', '')

  out.push('## Summary', '')
  const kinds = new Map<string, number>()
  for (const c of arch.components) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1)
  out.push(`- **Components:** ${arch.components.length} (${[...kinds].map(([k, n]) => `${n} × ${KIND_INFO[k as keyof typeof KIND_INFO].label}`).join(', ') || 'none'})`)
  out.push(`- **Estimated cost:** $${cost.toFixed(2)} per hour at today's load`)
  out.push(`- **Service-level targets:** ${pctLabel(slo.availability)} availability, p99 under ${ms(slo.p99Ms)}`)
  if (cap) {
    out.push(`- **Capacity:** ${cap.capped ? 'survives the largest load tried (64× today)' : `about ${Math.round(cap.maxRps ?? 0).toLocaleString('en-US')} requests per second, ${cap.multiple.toFixed(1)}× today's load`}`)
    if (cap.breaksBecause) out.push(`- **What gives out first:** ${cap.breaksBecause.title}. ${cap.breaksBecause.reasons[0] ?? ''}`)
  }
  const assumed = arch.components.reduce((n, c) => n + (c.assumed?.length ?? 0), 0)
  if (assumed) out.push(`- **Assumed settings:** ${assumed} setting${assumed === 1 ? '' : 's'} are defaults rather than values you chose`)
  out.push('')

  out.push('## Stress tests', '', 'Each scenario runs for 60 simulated seconds. A scenario survives when errors never exceed 2% of requests.', '')
  out.push('| Scenario | Result | Peak errors | Above 2% for | Peak p99 | SLO |', '| --- | --- | --- | --- | --- | --- |')
  const runs = SCENARIOS.map((s) => ({ s, r: runScenario(arch, s.id) }))
  for (const { s, r } of runs) out.push(runRow(s.label, r))
  const core = runs.filter(({ s, r }) => SUITE_IDS.includes(s.id) && !r.skipped)
  const live = runs.filter(({ r }) => !r.skipped)
  out.push('', `Survives ${live.filter(({ r }) => r.passes).length} of ${live.length} applicable scenarios (${core.filter(({ r }) => r.passes).length} of ${core.length} of the core three).`, '')

  const spofs = findSpofs(arch)
  out.push('## Single points of failure', '')
  out.push(...(spofs.length ? spofs.map((s) => `- **${s.name}:** ${s.reason}`) : ['None found.']), '')

  const rec = recoveryObjectives(arch)
  if (rec.length) {
    out.push('## Recovery objectives', '', '| Database | RTO (writes fail for) | RPO (writes that can be lost) | Note |', '| --- | --- | --- | --- |')
    for (const r of rec) out.push(`| ${cell(r.name)} | ${r.rtoSec === null ? 'manual restore' : `${r.rtoSec} s`} | ${r.rpoSec === null ? 'everything (no copy)' : r.rpoSec === 0 ? 'none' : `${r.rpoSec} s`} | ${cell(r.note)} |`)
    out.push('')
  }

  if (cap && cap.headroom.length) {
    out.push('## Headroom', '', "How many times today's load each component can take on its own, tightest first.", '')
    for (const h of cap.headroom.slice(0, 6)) out.push(`- **${h.name}:** ${isFinite(h.multiple) ? `${h.multiple.toFixed(1)}×` : 'idle'}`)
    out.push('')
  }

  const exps = arch.experiments ?? []
  if (exps.length) {
    out.push('## Chaos experiments', '', '| Experiment | Result | Peak errors | Above 2% for | Peak p99 | SLO |', '| --- | --- | --- | --- | --- | --- |')
    for (const e of exps) out.push(e.events.length ? runRow(e.name, runExperiment(arch, e)) : `| ${cell(e.name)} | no events | | | | |`)
    out.push('')
  }

  if (arch.actual) {
    const gaps = compareToReality(arch, arch.actual, project(arch))
    out.push('## Projected vs actual', '')
    if (!gaps.length) out.push('No comparable measurements were entered.')
    for (const g of gaps) out.push(`- **${g.label}:** model ${Math.round(g.projected * 10) / 10} ${g.unit}, measured ${Math.round(g.actual * 10) / 10} ${g.unit} (${g.verdict === 'close' ? 'close' : `model is ${g.verdict}`}). ${g.note}`)
    out.push('')
  }

  out.push('---', '', 'Generated by CloudSim. Estimates only: the model is deliberately small, and its assumptions are documented in docs/MODEL.md.', '')
  return out.join('\n')
}
