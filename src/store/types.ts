export type ComponentKind = 'client' | 'gateway' | 'loadBalancer' | 'appServers' | 'serverless' | 'database' | 'cache' | 'cdn' | 'queue' | 'bucket'

export interface ArchComponent {
  id: string
  kind: ComponentKind
  name: string
  position: { col: number; row: number }
  config: Record<string, number>
  /** Config keys that are defaults rather than user-provided. Shown as "assumed". */
  assumed?: string[]
}
/** `config` holds per-connection settings (see CONN_FIELDS in sim/balance.ts): weight, backup, drain. Absent means defaults. */
export interface Connection { id: string; from: string; to: string; config?: Record<string, number> }
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
  gateway: { label: 'API Gateway', blurb: 'The front door: rate-limits and filters requests before they reach your servers.' },
  loadBalancer: { label: 'Load Balancer', blurb: 'Splits requests across healthy targets.' },
  appServers: { label: 'App Servers', blurb: 'A rack of worker slots that fill with concurrency.' },
  serverless: { label: 'Serverless Function', blurb: 'Runs per request and scales on its own. Pay per use, with cold starts.' },
  database: { label: 'Database', blurb: 'Primary store with a connection-pool gauge.' },
  cache: { label: 'Cache', blurb: 'Serves repeat reads so the database stays calm.' },
  cdn: { label: 'CDN', blurb: 'Edge cache that answers repeat requests close to the user.' },
  queue: { label: 'Queue', blurb: 'A conveyor where depth is literal height.' },
  bucket: { label: 'Storage Bucket', blurb: 'Object storage for files and static assets.' },
}

export interface ConfigField { key: string; label: string; min: number; max: number; step: number; unit?: string; pct?: boolean; group?: string
  /** Rendered as an on/off switch (value 0 or 1). */
  toggle?: boolean
  /** Only shown, and only validated, when this other setting is on. Missing values are allowed. */
  showIf?: string
  /** Absent from older files and presets; treated as the default instead of being filled in on load. */
  optional?: boolean
  /** Not drawn as a generic slider: the inspector has its own control for it. */
  hidden?: boolean
}

export const CONFIG_SCHEMA: Record<ComponentKind, ConfigField[]> = {
  client: [
    { key: 'rps', label: 'Requests / sec', min: 50, max: 5000, step: 50, unit: 'rps' },
    { key: 'region', label: 'Region', min: 0, max: 5, step: 1, optional: true, hidden: true },
    { key: 'clientType', label: 'Client type', min: 0, max: 2, step: 1, optional: true, hidden: true },
    { key: 'payloadKb', label: 'Response size', min: 1, max: 1000, step: 1, unit: 'KB', optional: true, group: 'Request mix' },
    { key: 'readPct', label: 'Reads (rest are writes)', min: 0, max: 1, step: 0.05, pct: true, optional: true, group: 'Request mix' },
    { key: 'weight', label: 'Request cost (CPU)', min: 1, max: 5, step: 0.5, unit: '×', optional: true, group: 'Request mix' },
  ],
  gateway: [
    { key: 'limitOn', label: 'Rate limit', min: 0, max: 1, step: 1, toggle: true, optional: true },
    { key: 'rateLimit', label: 'Requests allowed per second', min: 100, max: 10000, step: 100, unit: 'rps', showIf: 'limitOn' },
    { key: 'geoMode', label: 'Geo rule', min: 0, max: 2, step: 1, optional: true, hidden: true },
    { key: 'geoMask', label: 'Geo regions', min: 0, max: 63, step: 1, optional: true, hidden: true },
  ],
  loadBalancer: [
    { key: 'targets', label: 'Targets', min: 1, max: 8, step: 1 },
    { key: 'geoMode', label: 'Geo rule', min: 0, max: 2, step: 1, optional: true, hidden: true },
    { key: 'geoMask', label: 'Geo regions', min: 0, max: 63, step: 1, optional: true, hidden: true },
    { key: 'policy', label: 'Balancing', min: 0, max: 3, step: 1, optional: true, hidden: true },
    { key: 'healthCheck', label: 'Health checks', min: 0, max: 1, step: 1, toggle: true, optional: true, group: 'Targets' },
    { key: 'hcInterval', label: 'Check every', min: 1, max: 30, step: 1, unit: 's', showIf: 'healthCheck', optional: true, group: 'Targets' },
    { key: 'hcFails', label: 'Failures before removal', min: 1, max: 6, step: 1, showIf: 'healthCheck', optional: true, group: 'Targets' },
    { key: 'slowStartSec', label: 'Slow start for new targets', min: 0, max: 120, step: 5, unit: 's', optional: true, group: 'Targets' },
    { key: 'drainSec', label: 'Connection draining', min: 0, max: 60, step: 5, unit: 's', optional: true, group: 'Targets' },
  ],
  appServers: [
    { key: 'instances', label: 'Instances (scale out)', min: 1, max: 20, step: 1, group: 'Scale' },
    { key: 'autoscale', label: 'Autoscaling', min: 0, max: 1, step: 1, toggle: true, optional: true, group: 'Scale' },
    { key: 'maxInstances', label: 'Maximum instances', min: 2, max: 20, step: 1, showIf: 'autoscale', optional: true, group: 'Scale' },
    { key: 'warmupSec', label: 'Instance start-up time', min: 5, max: 120, step: 5, unit: 's', showIf: 'autoscale', optional: true, group: 'Scale' },
    { key: 'scaleUpAt', label: 'Scale out above', min: 0.4, max: 0.95, step: 0.05, pct: true, showIf: 'autoscale', optional: true, group: 'Scale' },
    { key: 'vcpu', label: 'vCPUs per instance', min: 1, max: 32, step: 1, group: 'Instance size' },
    { key: 'ramGb', label: 'Memory per instance', min: 1, max: 128, step: 1, unit: 'GB', group: 'Instance size' },
    { key: 'geoMode', label: 'Geo rule', min: 0, max: 2, step: 1, optional: true, hidden: true },
    { key: 'geoMask', label: 'Geo regions', min: 0, max: 63, step: 1, optional: true, hidden: true },
  ],
  serverless: [
    { key: 'memoryMb', label: 'Memory (more memory = faster)', min: 128, max: 3008, step: 128, unit: 'MB' },
    { key: 'concurrency', label: 'Concurrency limit', min: 10, max: 3000, step: 10 },
    { key: 'provisioned', label: 'Always-warm instances', min: 0, max: 500, step: 10, optional: true },
  ],
  database: [
    { key: 'vcpu', label: 'vCPUs', min: 1, max: 64, step: 1, group: 'Instance size' },
    { key: 'ramGb', label: 'Memory', min: 1, max: 256, step: 1, unit: 'GB', group: 'Instance size' },
    { key: 'poolSize', label: 'Connection pool', min: 5, max: 200, step: 5, group: 'Connections' },
    { key: 'pooler', label: 'Connection pooler (proxy)', min: 0, max: 1, step: 1, toggle: true, optional: true, group: 'Connections' },
    { key: 'replicas', label: 'Read replicas', min: 0, max: 5, step: 1, optional: true, group: 'Replicas' },
  ],
  cache: [{ key: 'hitRate', label: 'Hit rate', min: 0, max: 1, step: 0.05, pct: true }],
  cdn: [{ key: 'hitRate', label: 'Hit rate', min: 0.5, max: 0.99, step: 0.01, pct: true }],
  bucket: [
    { key: 'prefixes', label: 'Key prefixes (spreads load)', min: 1, max: 10, step: 1 },
    { key: 'storageGb', label: 'Stored data', min: 10, max: 5000, step: 10, unit: 'GB' },
  ],
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
  cdn: { hitRate: 0.9 },
  bucket: { prefixes: 1, storageGb: 500 },
  gateway: { rateLimit: 2000 },
  serverless: { memoryMb: 512, concurrency: 1000 },
  queue: { capacity: 400, maxDepth: 2000 },
}

/** Defaults for optional settings, used when a component does not carry them. */
export const OPTIONAL_DEFAULTS: Partial<Record<ComponentKind, Record<string, number>>> = {
  gateway: { limitOn: 1, geoMode: 0, geoMask: 0 },
  serverless: { provisioned: 0 },
  database: { pooler: 0, replicas: 0 },
  client: { region: 0, clientType: 0, payloadKb: 4, readPct: 0.9, weight: 1 },
  loadBalancer: { geoMode: 0, geoMask: 0, policy: 0, healthCheck: 1, hcInterval: 5, hcFails: 3, slowStartSec: 0, drainSec: 0 },
  appServers: { autoscale: 0, maxInstances: 8, warmupSec: 20, scaleUpAt: 0.7, geoMode: 0, geoMask: 0 },
}

/** A setting's value, falling back to its default when the component does not carry it. */
export const configValue = (kind: ComponentKind, config: Record<string, number>, key: string): number | undefined =>
  config[key] ?? DEFAULT_CONFIG[kind][key] ?? OPTIONAL_DEFAULTS[kind]?.[key]
