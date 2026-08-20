// Publishing a stash file PUBLICLY and unencrypted.
//
// WHY THIS IS SEPARATE FROM SHARING
//
// "Share link" and "Publish publicly" sound like the same feature and have
// OPPOSITE privacy properties, so they are deliberately kept apart.
//
//   Share link       /public/{sha256}#{key} — the file stays encrypted on the
//                    server and the decryption key rides in the URL FRAGMENT,
//                    which browsers never send to a server. Zero-knowledge
//                    holds: we cannot read it, and only someone with the whole
//                    link can.
//   Publish publicly uploads an UNENCRYPTED copy. Anyone who learns the hash
//                    can read it, and so can we. This is a deliberate, per-file
//                    exception to zero-knowledge.
//
// The reason it has to exist: a Nostr profile picture is fetched by other
// people's clients, which expect raw image bytes at a plain URL. They do not
// run our JavaScript, and a URL fragment is never transmitted to the server, so
// the shared-link form can never work as a `picture` — every client shows a
// broken image.
//
// ON UNDOING IT
//
// Unpublishing is supported and genuinely removes OUR copy: delete the blob and
// this service stops serving those bytes. What it cannot do is reach copies
// other clients and relays have already fetched and cached. So the honest
// framing is "we stop serving it, but anything already downloaded is out of our
// reach" — not "this is permanent", and not "this fully retracts it" either.

import { API } from './api'
import { authPort } from './authBridge'
import { Crypto } from './crypto'
import { Keys } from './keys'
import { Relay } from './relay'
import type { SignedEvent } from './api'
import type { StashFile } from '../state/types'

/**
 * Host that serves unencrypted blobs by hash.
 *
 * blossom.cloistr.xyz and files.cloistr.xyz both route to the same service;
 * blossom is used here because it names what the URL is — a Blossom BUD-01
 * blob endpoint — and it is the form we want to see in other people's profile
 * metadata.
 */
export const PUBLIC_BLOB_HOST = 'https://blossom.cloistr.xyz'

/** The public, unauthenticated URL for an unencrypted blob. */
export function publicBlobUrl(sha256: string, host: string = PUBLIC_BLOB_HOST): string {
  return `${host.replace(/\/+$/, '')}/${sha256}`
}

export interface PublishResult {
  sha256: string
  url: string
}

/**
 * Merge a picture URL into existing kind-0 profile content.
 *
 * THE DANGEROUS PART. A kind-0 event REPLACES the previous one wholesale, so
 * publishing `{"picture": "..."}` on its own does not "set the picture" — it
 * erases the user's name, about, nip05, lud16 and everything else, across every
 * relay that accepts it. That is a destructive, effectively unrecoverable edit
 * to someone's public identity.
 *
 * So this merges into the existing content and preserves unknown keys, and
 * `readProfile` below refuses to guess when it cannot read the current profile.
 */
export function mergeProfilePicture(existingContent: string, pictureUrl: string): string {
  let profile: Record<string, unknown> = {}
  if (existingContent.trim()) {
    const parsed: unknown = JSON.parse(existingContent)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Existing profile is not a JSON object; refusing to overwrite it')
    }
    profile = parsed as Record<string, unknown>
  }
  return JSON.stringify({ ...profile, picture: pictureUrl })
}

/**
 * Upload an unencrypted copy of a file that is currently stored encrypted.
 *
 * `getPlaintext` is injected rather than imported so the decrypt pipeline stays
 * where it already lives (and so this is testable without libsodium).
 */
export async function publishPublicly(
  file: StashFile,
  getPlaintext: (file: StashFile) => Promise<Uint8Array>,
): Promise<PublishResult> {
  const bytes = await getPlaintext(file)
  const contentType = file.mime_type || 'application/octet-stream'
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: contentType })

  // Blossom auth binds to the hash of the bytes being uploaded, so it must be
  // computed over the PLAINTEXT copy — not the encrypted original's sha256.
  const hash = await sha256Hex(bytes)
  const authHeader = await authPort.createUploadAuth(hash, bytes.byteLength)

  // encryptionMode 'none' is what makes this readable by other clients. Every
  // other upload path in stash uses 'e2e'.
  const result = await API.uploadFile(blob, authHeader, 'none')
  const sha256 = (result.sha256 as string | undefined) ?? hash

  return { sha256, url: publicBlobUrl(sha256) }
}

/**
 * Stop serving a published blob.
 *
 * Returns normally on success. The caller is responsible for telling the user
 * the honest thing: our copy is gone, already-cached copies elsewhere are not.
 */
export async function unpublish(sha256: string): Promise<void> {
  const authHeader = await authPort.createDeleteAuth(sha256)
  // Same endpoint any file removal uses; the published copy is an ordinary
  // blob, distinguished only by having been stored unencrypted.
  await API.deleteFile(sha256, authHeader)
}

/** Current kind-0 for a pubkey, or null when the relay has none. */
export async function readProfile(pubkey: string): Promise<string | null> {
  const events = await Relay.subscribe({ kinds: [0], authors: [pubkey], limit: 1 })
  if (!events.length) return null
  // Newest wins if a relay hands back more than one.
  const newest = events.reduce((a, b) => ((b.created_at ?? 0) > (a.created_at ?? 0) ? b : a))
  return typeof newest.content === 'string' ? newest.content : ''
}

export interface SetProfilePictureDeps {
  pubkey: string
  signEvent: (event: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }) => Promise<SignedEvent>
}

/**
 * Signer bound to the current session.
 *
 * Defaulted rather than threaded through component props: the modal does not
 * need to know how signing works, and every call site would otherwise have to
 * plumb the same two values. Still injectable, so the merge logic stays
 * testable without a signer.
 */
function defaultProfileDeps(): SetProfilePictureDeps {
  const pubkey = authPort.pubkey
  if (!pubkey) throw new Error('Not signed in')
  return {
    pubkey,
    signEvent: event => authPort.signEvent(event),
  }
}

/**
 * Point the user's Nostr profile at a published URL.
 *
 * REFUSES when the current profile cannot be read. Publishing a kind-0 built
 * from nothing would wipe the user's existing profile everywhere, which is far
 * worse than the picture not updating. `allowEmptyProfile` exists for the
 * genuine case of a user who has never published a kind-0 at all, and the
 * caller must decide that deliberately.
 */
export async function setProfilePicture(
  pictureUrl: string,
  deps: SetProfilePictureDeps = defaultProfileDeps(),
  allowEmptyProfile = false,
): Promise<void> {
  const existing = await readProfile(deps.pubkey)

  if (existing === null && !allowEmptyProfile) {
    throw new Error(
      'Could not read your current Nostr profile. Refusing to publish, because doing so would replace your existing profile fields.',
    )
  }

  const content = mergeProfilePicture(existing ?? '', pictureUrl)
  const signed = await deps.signEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  })
  await Relay.publish(signed)
}

/**
 * Fetch a stored file and decrypt it to plaintext bytes.
 *
 * NOTE: this download-derive-decrypt sequence is duplicated in App.tsx,
 * FileInfoModal, PreviewModal and KeyboardShortcuts. This is a fifth copy, and
 * that is worth fixing — but consolidating all five is a refactor of its own
 * and does not belong inside a feature change. Flagged here rather than done
 * silently or pretended away.
 */
export async function getPlaintextBytes(file: StashFile): Promise<Uint8Array> {
  const f = file as unknown as Record<string, unknown>
  const sha256 = f.sha256 as string | undefined
  if (!sha256) throw new Error('File has no content hash')

  const response = await fetch(API.getDownloadURL(sha256))
  if (!response.ok) throw new Error(`Could not fetch file: ${response.status}`)
  const stored = await response.arrayBuffer()

  const encrypted = Boolean(f.encrypted || f.encryption)
  if (!encrypted) return new Uint8Array(stored)

  const fileId = (f.file_id ?? f.fileId ?? f.d ?? f.id) as string | undefined
  const folderId = (f.folder_id ?? f.folderId ?? f.folder ?? null) as string | null
  if (!fileId) throw new Error('Cannot decrypt: missing file ID')

  const fileKey = folderId
    ? await Keys.deriveFileKey(folderId, fileId)
    : await Keys.deriveRootFileKey(fileId)
  try {
    return await Crypto.decryptFile(stored, fileKey)
  } finally {
    // Always wipe, including on a decrypt failure.
    Crypto.wipeKey(fileKey)
  }
}

/** Hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
