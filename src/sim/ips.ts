/**
 * Per-IP traffic. A client component stands for many users. With "Model individual IPs" on, its traffic is a set of IPs whose rates
 * are spread between a minimum and a maximum, so a gateway can limit each IP on its own and we can see who gets turned away.
 * Deterministic on purpose: the same settings always give the same crowd, so results do not flicker from run to run.
 */
import { configValue } from '../store/types'
import type { ArchComponent } from '../store/types'

export interface IpCrowd { n: number; min: number; max: number; skew: number }

/** The crowd a client describes, or null when it is not modelling individual IPs. */
export function crowdOf(c: ArchComponent): IpCrowd | null {
  if (c.kind !== 'client' || (configValue('client', c.config, 'perIpOn') ?? 0) < 0.5) return null
  const min = configValue('client', c.config, 'ipMinRps') ?? 1
  const max = Math.max(min, configValue('client', c.config, 'ipMaxRps') ?? 10)
  return { n: Math.max(1, Math.round(configValue('client', c.config, 'ips') ?? 100)), min, max, skew: configValue('client', c.config, 'ipSkew') ?? 0.5 }
}

const cache = new Map<string, number[]>()

/** Rate of every IP, lowest to highest. Skew 0 spreads them evenly across the range; higher skew leaves most near the minimum and a few near the maximum. */
export function ipRates(k: IpCrowd): number[] {
  const key = `${k.n}|${k.min}|${k.max}|${k.skew}`
  let r = cache.get(key)
  if (!r) {
    const p = 1 + 4 * k.skew
    r = Array.from({ length: k.n }, (_, i) => k.min + (k.max - k.min) * Math.pow((i + 0.5) / k.n, p))
    if (cache.size > 64) cache.clear()
    cache.set(key, r)
  }
  return r
}

export const crowdTotal = (k: IpCrowd) => ipRates(k).reduce((a, b) => a + b, 0)

/** Requests per second turned away when every IP's rate is multiplied by `scale` and each is capped at `cap`. */
export function overCap(k: IpCrowd, scale: number, cap: number): { dropped: number; ipsLimited: number } {
  let dropped = 0, ipsLimited = 0
  for (const r of ipRates(k)) { const v = r * scale; if (v > cap) { dropped += v - cap; ipsLimited++ } }
  return { dropped, ipsLimited }
}

/** Total requests per second a client sends: its own slider, or the sum over its IPs. */
export function clientRps(c: ArchComponent): number {
  const k = crowdOf(c)
  return k ? crowdTotal(k) : (configValue('client', c.config, 'rps') ?? 0)
}
