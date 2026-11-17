/**
 * Share a design as a link: the design is packed into the part of the address after the "#", so nothing is sent to any
 * server. Whatever arrives from a link is untrusted, so it goes through the same validation as an imported file.
 */
import type { Architecture } from '../store/types'
import { parseProject, PROJECT_VERSION, type ParseResult } from '../store/project'

export const SHARE_PREFIX = '#d=v1.'
/** Links longer than this are refused: browsers and chat apps start truncating them. */
export const SHARE_MAX = 60_000

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))
}

/** The hash for a design, or null if it is too big to share as a link. */
export function encodeShare(arch: Architecture): string | null {
  const hash = SHARE_PREFIX + toBase64Url(JSON.stringify({ app: 'cloudsim', version: PROJECT_VERSION, architecture: arch }))
  return hash.length <= SHARE_MAX ? hash : null
}

/** Reads a design back from a location hash. Returns null when the hash is not a share link at all. */
export function decodeShare(hash: string): ParseResult | null {
  if (!hash.startsWith(SHARE_PREFIX)) return null
  const body = hash.slice(SHARE_PREFIX.length)
  if (body.length > SHARE_MAX) return { ok: false, error: 'That link is too long to be a CloudSim design.' }
  if (!/^[A-Za-z0-9_-]*$/.test(body)) return { ok: false, error: "That link doesn't look like a CloudSim design." }
  let text: string
  try { text = fromBase64Url(body) } catch { return { ok: false, error: "That link is damaged: it can't be read." } }
  return parseProject(text)
}
