/**
 * Small statistics helpers for latency. The engine only tracks a median and a p99 per hop, so the whole
 * distribution is approximated as log-normal and anything that needs "what share of requests are slower
 * than T" reads it off that curve. This is an approximation, not a measured distribution.
 */

/** Error function (Abramowitz-Stegun 7.1.26), accurate to about 1.5e-7. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

/** z-score of the 99th percentile. */
const Z99 = 2.3263

/**
 * Share of requests slower than `limitMs`, given a median and a p99. A limit of 0 means "no timeout".
 * When p99 is not above the median the spread is taken as a small default, so the answer is a step around the median.
 */
export function shareSlowerThan(p50: number, p99: number, limitMs: number): number {
  if (limitMs <= 0 || p50 <= 0) return 0
  const sigma = p99 > p50 * 1.0001 ? Math.log(p99 / p50) / Z99 : 0.05
  const z = (Math.log(limitMs) - Math.log(p50)) / sigma
  return Math.min(1, Math.max(0, 1 - phi(z)))
}
