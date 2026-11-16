export type ComponentKind = 'client' | 'loadBalancer' | 'appServers' | 'database' | 'cache' | 'queue'

export interface ArchComponent {
  id: string
  kind: ComponentKind
  name: string
  position: { col: number; row: number }
  config: Record<string, number>
  /** Config keys that are defaults rather than user-provided. Shown as "assumed". */
  assumed?: string[]
}
export interface Connection { id: string; from: string; to: string }
/** Service-level targets for a design. Optional: older files and presets use the defaults. */
export interface Slo {
  /** Share of requests that must succeed, e.g. 0.995. */
  availability: number
  /** The p99 latency that should not be exceeded, in ms. */
  p99Ms: number
}
export interface Architecture { name: string; components: ArchComponent[]; connections: Connection[]; slo?: Slo }

export const KIND_INFO: Record<ComponentKind, { label: string; blurb: string }> = {
  client: { label: 'Client', blurb: 'Source of all traffic into the system.' },
  loadBalancer: { label: 'Load Balancer', blurb: 'Splits requests across healthy targets.' },
  appServers: { label: 'App Servers', blurb: 'A rack of worker slots that fill with concurrency.' },
  database: { label: 'Database', blurb: 'Primary store with a connection-pool gauge.' },
  cache: { label: 'Cache', blurb: 'Serves repeat reads so the database stays calm.' },
  queue: { label: 'Queue', blurb: 'A conveyor where depth is literal height.' },
}

export interface ConfigField { key: string; label: string; min: number; max: number; step: number; unit?: string; pct?: boolean; group?: string
  /** Rendered as an on/off switch (value 0 or 1). */
  toggle?: boolean
  /** Only shown, and only validated, when this other setting is on. Missing values are allowed. */
  showIf?: string
  /** Absent from older files and presets; treated as the default instead of being filled in on load. */
  optional?: boolean
}

export const CONFIG_SCHEMA: Record<ComponentKind, ConfigField[]> = {
  client: [{ key: 'rps', label: 'Requests / sec', min: 50, max: 5000, step: 50, unit: 'rps' }],
  loadBalancer: [{ key: 'targets', label: 'Targets', min: 1, max: 8, step: 1 }],
  appServers: [
    { key: 'instances', label: 'Instances (scale out)', min: 1, max: 20, step: 1, group: 'Scale' },
    { key: 'autoscale', label: 'Autoscaling', min: 0, max: 1, step: 1, toggle: true, optional: true, group: 'Scale' },
    { key: 'maxInstances', label: 'Maximum instances', min: 2, max: 20, step: 1, showIf: 'autoscale', optional: true, group: 'Scale' },
    { key: 'warmupSec', label: 'Instance start-up time', min: 5, max: 120, step: 5, unit: 's', showIf: 'autoscale', optional: true, group: 'Scale' },
    { key: 'scaleUpAt', label: 'Scale out above', min: 0.4, max: 0.95, step: 0.05, pct: true, showIf: 'autoscale', optional: true, group: 'Scale' },
    { key: 'vcpu', label: 'vCPUs per instance', min: 1, max: 32, step: 1, group: 'Instance size' },
    { key: 'ramGb', label: 'Memory per instance', min: 1, max: 128, step: 1, unit: 'GB', group: 'Instance size' },
  ],
  database: [
    { key: 'vcpu', label: 'vCPUs', min: 1, max: 64, step: 1, group: 'Instance size' },
    { key: 'ramGb', label: 'Memory', min: 1, max: 256, step: 1, unit: 'GB', group: 'Instance size' },
    { key: 'poolSize', label: 'Connection pool', min: 5, max: 200, step: 5, group: 'Connections' },
  ],
  cache: [{ key: 'hitRate', label: 'Hit rate', min: 0, max: 1, step: 0.05, pct: true }],
  queue: [
    { key: 'capacity', label: 'Drain rate', min: 50, max: 2000, step: 50, unit: 'msg/s' },
    { key: 'maxDepth', label: 'Max depth', min: 100, max: 10000, step: 100 },
  ],
}

export const DEFAULT_CONFIG: Record<ComponentKind, Record<string, number>> = {
  client: { rps: 500 },
  loadBalancer: { targets: 2 },
  appServers: { instances: 2, vcpu: 4, ramGb: 8 },
  database: { vcpu: 4, ramGb: 16, poolSize: 20 },
  cache: { hitRate: 0.8 },
  queue: { capacity: 400, maxDepth: 2000 },
}

/** Defaults for optional settings, used when a component does not carry them. */
export const OPTIONAL_DEFAULTS: Partial<Record<ComponentKind, Record<string, number>>> = {
  appServers: { autoscale: 0, maxInstances: 8, warmupSec: 20, scaleUpAt: 0.7 },
}

/** A setting's value, falling back to its default when the component does not carry it. */
export const configValue = (kind: ComponentKind, config: Record<string, number>, key: string): number | undefined =>
  config[key] ?? DEFAULT_CONFIG[kind][key] ?? OPTIONAL_DEFAULTS[kind]?.[key]
