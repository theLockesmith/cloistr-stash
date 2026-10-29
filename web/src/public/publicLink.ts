// Opening a public share link: /public/{sha256}#{key}.
//
// The key is in the URL fragment, which browsers never send to a server, so
// Stash's server sees only the blob hash. The blob is fetched through Stash
// (/api/files/{sha256}/download) and decrypted here with the same
// XChaCha20-Poly1305 code (stash-core Crypto, chunked or not) that encrypted
// it. libsodium comes from the app bundle; nothing loads from a CDN.

import { Crypto } from '@cloistr/stash-core/crypto'

export interface PublicLinkTarget {
  sha256: string
  key: Uint8Array
}

export type ParsedLink = { ok: true; link: PublicLinkTarget } | { ok: false; reason: 'bad-path' | 'no-key' | 'bad-key' }

const HASH = /^\/public\/([0-9a-f]{64})\/?$/

export function isPublicLinkPath(pathname: string): boolean {
  return HASH.test(pathname)
}

export function parsePublicLink(pathname: string, fragment: string): ParsedLink {
  const m = HASH.exec(pathname)
  if (!m) return { ok: false, reason: 'bad-path' }
  const encoded = fragment.replace(/^#/, '')
  if (!encoded) return { ok: false, reason: 'no-key' }
  let key: Uint8Array
  try {
    key = Crypto.base64urlToBytes(encoded)
  } catch {
    return { ok: false, reason: 'bad-key' }
  }
  if (key.length !== 32) return { ok: false, reason: 'bad-key' }
  return { ok: true, link: { sha256: m[1], key } }
}

export interface OpenedFile {
  bytes: Uint8Array
  name: string
  mimeType: string
}

type Fetch = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'arrayBuffer'>>

/** The file's name and type, if the server can still read them (old-shape files). */
async function metadata(fetchFn: Fetch, sha256: string): Promise<{ name?: string; mimeType?: string }> {
  try {
    const r = await fetchFn(`/api/public/${sha256}`)
    if (!r.ok) return {}
    const m = (await r.json()) as { name?: unknown; mime_type?: unknown }
    return {
      name: typeof m.name === 'string' && m.name ? m.name : undefined,
      mimeType: typeof m.mime_type === 'string' && m.mime_type ? m.mime_type : undefined,
    }
  } catch {
    return {}
  }
}

/** Download and decrypt. Throws a message fit to show the reader. */
export async function openPublicLink(link: PublicLinkTarget, fetchFn: Fetch = fetch): Promise<OpenedFile> {
  await Crypto.init()
  const [meta, res] = await Promise.all([metadata(fetchFn, link.sha256), fetchFn(`/api/files/${link.sha256}/download`)])
  if (res.status === 404) throw new Error('This file is no longer available.')
  if (res.status === 403) throw new Error('This link has reached its download limit.')
  if (!res.ok) throw new Error(`The file could not be downloaded (${res.status}).`)
  const stored = new Uint8Array(await res.arrayBuffer())
  let bytes: Uint8Array
  try {
    bytes = await Crypto.decryptFile(stored, link.key)
  } catch {
    throw new Error('The file could not be decrypted. The link may be incomplete or wrong.')
  }
  return { bytes, name: meta.name ?? 'download', mimeType: meta.mimeType ?? 'application/octet-stream' }
}
