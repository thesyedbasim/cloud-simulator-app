/**
 * Regions, client traffic attributes and geo rules. Stored as plain numbers in a component's config so
 * saved files, undo and the existing validation keep working unchanged.
 *
 * - A client's `region` is an index into REGIONS.
 * - A load balancer or app tier has `geoMode` (0 off, 1 allow only the ticked regions, 2 block the ticked
 *   regions) and `geoMask`, a bit set with one bit per region.
 */
import type { ArchComponent, Architecture } from '../store/types'
import { configValue } from '../store/types'

export const REGIONS = [
  { id: 'us-east', label: 'US-East', short: 'USE' },
  { id: 'us-west', label: 'US-West', short: 'USW' },
  { id: 'eu', label: 'EU', short: 'EU' },
  { id: 'apac', label: 'APAC', short: 'APAC' },
  { id: 'latam', label: 'LATAM', short: 'LAT' },
  { id: 'mea', label: 'Middle East / Africa', short: 'MEA' },
] as const

export const CLIENT_TYPES = [
  { id: 'human', label: 'People (web)' },
  { id: 'mobile', label: 'Mobile app' },
  { id: 'bot', label: 'Bots / scrapers' },
] as const

export type GeoMode = 0 | 1 | 2
export const GEO_OFF = 0, GEO_ALLOW = 1, GEO_BLOCK = 2
export const ALL_REGIONS_MASK = (1 << REGIONS.length) - 1

/** Kinds that can enforce geo rules. A load balancer blocks cheaply at the edge; an app tier still spends some CPU. */
export const canGeoBlock = (kind: ArchComponent['kind']) => kind === 'loadBalancer' || kind === 'appServers' || kind === 'gateway'

/** Share of a normal request's capacity that rejecting a blocked request still costs. */
export const BLOCK_COST: Record<'loadBalancer' | 'appServers' | 'gateway', number> = { loadBalancer: 0.02, appServers: 0.1, gateway: 0.02 }

export const regionOf = (c: Pick<ArchComponent, 'kind' | 'config'>): number => {
  const r = Math.round(configValue('client', c.config, 'region') ?? 0)
  return r >= 0 && r < REGIONS.length ? r : 0
}

export const geoModeOf = (c: Pick<ArchComponent, 'kind' | 'config'>): GeoMode => {
  if (!canGeoBlock(c.kind)) return GEO_OFF
  const m = Math.round(configValue(c.kind, c.config, 'geoMode') ?? 0)
  return m === GEO_ALLOW || m === GEO_BLOCK ? m : GEO_OFF
}

export const geoMaskOf = (c: Pick<ArchComponent, 'kind' | 'config'>): number => Math.round(configValue(c.kind, c.config, 'geoMask') ?? 0) & ALL_REGIONS_MASK

/** Does this component's geo rule let traffic from `region` through? */
export function geoAllows(c: Pick<ArchComponent, 'kind' | 'config'>, region: number): boolean {
  const mode = geoModeOf(c)
  if (mode === GEO_OFF) return true
  const listed = (geoMaskOf(c) & (1 << region)) !== 0
  return mode === GEO_ALLOW ? listed : !listed
}

/** Plain-language description of a rule, e.g. "Allows only EU, US-East". Null when no rule is set. */
export function describeGeo(c: Pick<ArchComponent, 'kind' | 'config'>): string | null {
  const mode = geoModeOf(c)
  if (mode === GEO_OFF) return null
  const mask = geoMaskOf(c)
  const names = REGIONS.filter((_, i) => mask & (1 << i)).map((r) => r.label)
  if (mode === GEO_ALLOW) return names.length ? `Allows only ${names.join(', ')}` : 'Allows no region'
  return names.length ? `Blocks ${names.join(', ')}` : 'Blocks nothing'
}

/** The geo rule a given source (client) region runs into first, along any path, for explanations. */
export const clientRegions = (arch: Architecture) =>
  arch.components.filter((c) => c.kind === 'client').map((c) => ({ id: c.id, region: regionOf(c) }))

/** Data-transfer price in $ per GB. An assumed, rounded figure. */
export const EGRESS_USD_PER_GB = 0.05
/** Heavier write requests cost more at the database than reads. */
export const WRITE_COST = 3
/** The mix the database capacity numbers assume: 90% reads. Using it as the baseline keeps defaults unchanged. */
export const BASELINE_READ = 0.9
const BASELINE_UNIT = BASELINE_READ + (1 - BASELINE_READ) * WRITE_COST

/** Capacity units one request from this client uses at a given kind of component (1 = a normal request). */
export function loadUnit(kind: ArchComponent['kind'], client: Pick<ArchComponent, 'config'>, target?: Pick<ArchComponent, 'config'>): number {
  if (kind === 'appServers') return configValue('client', client.config, 'weight') ?? 1
  if (kind === 'database') {
    const read = configValue('client', client.config, 'readPct') ?? BASELINE_READ
    // Reads can be served by any replica, so the primary only carries its share of them; every write stays on the primary.
    // With strong consistency every read goes to the primary, so replicas take no share of them.
    const strong = target ? (configValue('database', target.config, 'consistency') ?? 0) >= 0.5 : false
    const replicas = target && !strong ? Math.round(configValue('database', target.config, 'replicas') ?? 0) : 0
    return (read / (1 + replicas) + (1 - read) * WRITE_COST) / BASELINE_UNIT
  }
  return 1
}
