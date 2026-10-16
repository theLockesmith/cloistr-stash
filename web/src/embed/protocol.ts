// The Stash embed's contract with the page that frames it (Space).
//
// Stash serves its Files view at /embed/files; Space frames it. The keys never
// leave Stash's origin: the embed lists the drive itself and sends the parent
// only what the user picks, by postMessage, to ONE exact origin.
//
// Who may frame it is decided twice, from the same configured list
// (CLOISTR_EMBED_PARENTS, served in /config.js as `embedParents`):
//   1. the server sends it as the page's CSP frame-ancestors, so the browser
//      refuses to render the embed inside any other site;
//   2. the embed reads the parent it was told (?parent=<origin>), refuses
//      unless that is exactly one of the list, and posts only to that origin,
//      so a parent that lied about itself receives nothing.
//
// The embed accepts NO inbound messages. Everything it needs comes from its
// own URL, so there is no message handler for a hostile page to reach.
//
// Outbound messages (all carry source and version):
//   { type: 'ready', signedIn }       once on load, and again when sign-in changes
//   { type: 'picked', items }         the user chose files (pick mode)
//   { type: 'cancelled' }             the user closed the picker (pick mode)
//   { type: 'resize', height }        content height in CSS pixels
// A picked item is { name, sha256, size, mimeType }. sha256 is the hash of
// the ENCRYPTED blob: it identifies the file, it does not open it.

import type { StashFile } from '@cloistr/stash-core/types'

export const EMBED_SOURCE = 'cloistr-stash-embed'
export const EMBED_VERSION = 1

export type EmbedMode = 'browse' | 'pick'

export interface PickedItem {
  name: string
  sha256: string
  size: number | null
  mimeType: string | null
}

export type EmbedMessage =
  | { type: 'ready'; signedIn: boolean }
  | { type: 'picked'; items: PickedItem[] }
  | { type: 'cancelled' }
  | { type: 'resize'; height: number }

export type Envelope = EmbedMessage & { source: typeof EMBED_SOURCE; version: typeof EMBED_VERSION }

/**
 * Origins allowed to frame the embed, from /config.js. Each entry must
 * already be an exact origin (the server dropped anything else); this repeats
 * the check so a hand-edited config cannot widen it to a wildcard.
 */
export function allowedParents(config: unknown): string[] {
  const raw = (config as { embedParents?: unknown } | undefined)?.embedParents
  if (typeof raw !== 'string') return []
  return raw.split(/\s+/).filter(isExactOrigin)
}

export function isExactOrigin(value: string): boolean {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  // URL accepts '*' in a host; a wildcard is never an exact origin.
  if (u.hostname.includes('*')) return false
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return false
  // URL.origin is what a browser reports in MessageEvent.origin; an entry
  // that is not already that exact string can never match one.
  return u.origin === value
}

export type ParentCheck =
  | { ok: true; parent: string; mode: EmbedMode }
  | { ok: false; reason: 'not-framed' | 'no-parent' | 'parent-not-allowed' | 'parent-mismatch' }

/**
 * Decide whether to talk to the parent at all, and to which origin.
 *
 * `ancestorOrigins` is location.ancestorOrigins where the browser has it
 * (Chromium, Safari): the real origin of the page that framed us. When
 * present it must equal the claimed parent. Firefox lacks it; there the CSP
 * and the exact targetOrigin on every post carry the check.
 */
export function checkParent(opts: {
  search: string
  framed: boolean
  allowed: readonly string[]
  ancestorOrigins?: ArrayLike<string> | null
}): ParentCheck {
  if (!opts.framed) return { ok: false, reason: 'not-framed' }
  const params = new URLSearchParams(opts.search)
  const parent = params.get('parent')
  if (!parent) return { ok: false, reason: 'no-parent' }
  if (!opts.allowed.includes(parent)) return { ok: false, reason: 'parent-not-allowed' }
  const actual = opts.ancestorOrigins && opts.ancestorOrigins.length > 0 ? opts.ancestorOrigins[0] : null
  if (actual !== null && actual !== parent) return { ok: false, reason: 'parent-mismatch' }
  const mode: EmbedMode = params.get('mode') === 'pick' ? 'pick' : 'browse'
  return { ok: true, parent, mode }
}

/** Only these four fields cross to the parent; never keys, ids or folders. */
export function toPicked(file: StashFile): PickedItem {
  return {
    name: String(file.name),
    sha256: String(file.sha256),
    size: typeof file.size === 'number' ? file.size : null,
    mimeType: typeof file.mime_type === 'string' ? file.mime_type : null,
  }
}

export function envelope(msg: EmbedMessage): Envelope {
  return { ...msg, source: EMBED_SOURCE, version: EMBED_VERSION }
}

/** Post to the one checked parent origin. Never '*'. */
export function postToParent(target: Pick<Window, 'postMessage'>, parent: string, msg: EmbedMessage): void {
  target.postMessage(envelope(msg), parent)
}
