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

/**
 * Inverse of the standard normal curve (Acklam's rational approximation, relative error about 1e-9):
 * the z-score for a given percentile, e.g. 0.99 → 2.326.
 */
export function zOf(p: number): number {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p))
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const lo = 0.02425
  if (q < lo) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1) }
  if (q > 1 - lo) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1) }
  const r = q - 0.5
  const t = r * r
  return ((((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * r) / (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1)
}

/** Downstream latency is taken to spread so that its p99 is 4× its median (the same assumption the call timeout makes). */
export const TAIL_RATIO = 4

/**
 * What waiting for the slowest of `n` parallel calls does to the median and the p99 of the wait, as multiples of a single
 * call's median. One call: 1× the median and 4× at the p99. A hundred: the slowest of them is nearly always a slow one.
 */
export function fanOutLatency(n: number): { p50: number; p99: number } {
  const sigma = Math.log(TAIL_RATIO) / Z99
  const k = Math.max(1, n)
  return { p50: Math.exp(sigma * zOf(Math.pow(0.5, 1 / k))), p99: Math.exp(sigma * zOf(Math.pow(0.99, 1 / k))) }
}
