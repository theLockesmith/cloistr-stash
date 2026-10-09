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
import { readFileBytes, type FileRef } from './fileKey'
import { Relay } from './relay'
import { BLOB_HOST, DISCOVERY_URL, RELAY_URL } from './serviceConfig'
import { RelayPrefs } from './relayprefs'
import type { SignedEvent } from './api'
import type { StashFile } from './types'

/**
 * Host that serves unencrypted blobs by hash.
 *
 * blossom.cloistr.xyz and files.cloistr.xyz both route to the same service;
 * blossom is used here because it names what the URL is — a Blossom BUD-01
 * blob endpoint — and it is the form we want to see in other people's profile
 * metadata. Configurable per environment (serviceConfig.BLOB_HOST).
 */
export const PUBLIC_BLOB_HOST = BLOB_HOST

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

/**
 * The current kind-0 for a pubkey.
 *
 * THREE outcomes, not two. Returning `null` for both "the relay has no profile
 * for you" and "we could not reach the relay" is what made setProfilePicture
 * refuse for a user who simply has no profile yet: there is nothing to
 * overwrite, so publishing is safe, but the guard could not tell the cases
 * apart. Verified 2026-08-25 — neither the operator's pubkey nor the test
 * account has any kind-0 on relay.cloistr.xyz, so "Use as Nostr profile
 * picture" could never succeed for either.
 *
 *   found      — a kind-0 exists; merge into it
 *   absent     — the relay answered, and there is none; safe to create one
 *   unreadable — the query failed; refuse, because we cannot know
 */
export type ProfileRead =
  | { status: 'found'; content: string }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string }

type ProfileEvent = { created_at?: number; content?: unknown }

/**
 * Where a user's profile may live, and how to ask one relay for it. Both throw
 * when they cannot answer; neither ever turns "no answer" into "nothing there".
 */
export interface ProfileSources {
  /** The user's own relays (NIP-65 / cloistr-relays), excluding ours. Throws if unknown. */
  relayList(pubkey: string): Promise<string[]>
  /** kind-0 events for pubkey on one relay. Throws unless the relay finished answering (EOSE). */
  query(url: string, pubkey: string): Promise<ProfileEvent[]>
}

/**
 * Read the user's profile from our relay AND the user's own relays (found
 * 2026-10-09: reading only ours, a user whose profile lives elsewhere read as
 * "absent", and the kind-0 we then published replaced their whole profile).
 *
 *   found      — some relay has a kind-0; the newest wins
 *   absent     — every relay answered, and none has one; safe to create
 *   unreadable — the relay list, or any relay, did not answer; refuse
 */
export async function readProfile(pubkey: string, sources: ProfileSources = defaultProfileSources()): Promise<ProfileRead> {
  let urls: string[]
  try {
    urls = [...new Set([RELAY_URL, ...(await sources.relayList(pubkey))])]
  } catch (err) {
    return { status: 'unreadable', reason: `could not look up your relays: ${err instanceof Error ? err.message : String(err)}` }
  }
  const answers = await Promise.allSettled(urls.map((url) => sources.query(url, pubkey)))
  const found = answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : []))
  if (found.length) {
    // Newest wins if relays disagree.
    const newest = found.reduce((a, b) => ((b.created_at ?? 0) > (a.created_at ?? 0) ? b : a))
    return { status: 'found', content: typeof newest.content === 'string' ? newest.content : '' }
  }
  const failed = answers.filter((a) => a.status === 'rejected').length
  if (failed) return { status: 'unreadable', reason: `${failed} of ${urls.length} relays did not answer` }
  return { status: 'absent' }
}

/** One REQ to one relay; resolves only on EOSE. */
function queryOneRelay(url: string, filter: Record<string, unknown>, timeoutMs = 8000): Promise<ProfileEvent[]> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      reject(err)
      return
    }
    const subId = 'p' + Math.random().toString(36).slice(2, 10)
    const events: ProfileEvent[] = []
    const done = (err?: Error) => {
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      if (err) reject(err)
      else resolve(events)
    }
    const timer = setTimeout(() => done(new Error(`${url}: no answer`)), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]))
    ws.onerror = () => done(new Error(`${url}: connection failed`))
    ws.onclose = () => done(new Error(`${url}: closed before answering`))
    ws.onmessage = (msg) => {
      try {
        const m = JSON.parse(String(msg.data)) as unknown[]
        if (m[1] !== subId) return
        if (m[0] === 'EVENT') events.push(m[2] as ProfileEvent)
        else if (m[0] === 'EOSE') { ws.onclose = null; done() }
        else if (m[0] === 'CLOSED') done(new Error(`${url}: ${String(m[2])}`))
      } catch { /* ignore malformed frames */ }
    }
  })
}

function defaultProfileSources(): ProfileSources {
  return {
    async relayList(pubkey) {
      const relays = (prefs: { readRelays: string[]; writeRelays: string[] } | null) =>
        prefs ? [...prefs.writeRelays, ...prefs.readRelays] : []
      // Discovery first; a 404 means it has no list, anything else is no answer.
      try {
        const res = await fetch(`${DISCOVERY_URL}/api/v1/relay-prefs/${pubkey}`, { headers: { Accept: 'application/json' } })
        if (res.ok) {
          const list = relays(RelayPrefs.parseDiscoveryResponse(await res.json()))
          if (list.length) return list
        }
      } catch { /* fall through to our relay */ }
      // Our relay's copies of the lists. Relay.subscribe rejects on a timeout,
      // so reaching the return means it answered (possibly with none).
      const [nip65, cloistr] = await Promise.all([
        Relay.subscribe({ kinds: [10002], authors: [pubkey], limit: 1 }, 5000),
        Relay.subscribe({ kinds: [30078], authors: [pubkey], '#d': ['cloistr-relays'], limit: 1 }, 5000),
      ])
      return [...nip65, ...cloistr].flatMap((e) => relays(RelayPrefs.parseRelayTags((e as { tags: string[][] }).tags)))
    },
    async query(url, pubkey) {
      const filter = { kinds: [0], authors: [pubkey], limit: 1 }
      if (url === RELAY_URL) return (await Relay.subscribe(filter)) as ProfileEvent[]
      return queryOneRelay(url, filter)
    },
  }
}

export interface SetProfilePictureDeps {
  pubkey: string
  /** Where to read the existing profile from (defaults to our relay + the user's relays). */
  sources?: ProfileSources
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
 * REFUSES when the current profile cannot be READ (relay unreachable), because
 * publishing a kind-0 built from nothing would wipe the user's existing profile
 * everywhere — far worse than the picture not updating.
 *
 * Does NOT refuse when the relay answers and there is simply no profile yet:
 * nothing exists to overwrite, so creating one is safe. Conflating those two
 * was a bug; a user with no kind-0 could never set a picture at all.
 */
export async function setProfilePicture(
  pictureUrl: string,
  deps: SetProfilePictureDeps = defaultProfileDeps(),
  allowEmptyProfile = false,
): Promise<void> {
  const existing = await readProfile(deps.pubkey, deps.sources)

  // Refuse ONLY when we genuinely could not look. An absent profile has nothing
  // to overwrite, so creating one is safe and is the common case for a new user.
  if (existing.status === 'unreadable' && !allowEmptyProfile) {
    throw new Error(
      'Could not reach a relay to read your current Nostr profile. Refusing to publish, ' +
        'because doing so would replace your existing profile fields. Please try again.',
    )
  }

  const content = mergeProfilePicture(
    existing.status === 'found' ? existing.content : '',
    pictureUrl,
  )
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
 * The five copies of this sequence (here, App.tsx, FileInfoModal, PreviewModal,
 * KeyboardShortcuts) are now one: lib/fileKey.readFileBytes, which also uses
 * the file's wrapped key instead of always deriving HKDF.
 */
export async function getPlaintextBytes(file: StashFile): Promise<Uint8Array> {
  return readFileBytes(file as unknown as FileRef)
}

/** Hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The public URL for a file that has been published, or null when the file
 * cannot have one.
 *
 * NOTHING NEW IS STORED. Publishing uploads an unencrypted copy keyed by the
 * hash of the PLAINTEXT bytes, and that hash is already persisted on the file's
 * kind-30078 metadata as the `ox` tag (NIP-94's "original file hash"), written
 * at upload time. So the link is derivable from the file record; it was simply
 * never surfaced, which is why the only way to see it again was to re-run the
 * whole "Share publicly" flow.
 *
 * Deriving beats storing a second copy of the URL: there is no way for it to
 * drift from the bytes it names.
 */
export function publicUrlForFile(file: StashFile): string | null {
  const f = file as unknown as Record<string, unknown>
  const plaintextHash = (f.plaintext_hash || f.plaintextHash) as string | undefined
  if (!plaintextHash) return null
  return publicBlobUrl(plaintextHash)
}

/**
 * Is the public copy actually being served right now?
 *
 * Deliberately a live check rather than a stored flag. A flag would go stale
 * the moment the file is unpublished from another device, and would then hand
 * the user a link that 404s — worse than showing nothing. This asks the server,
 * so the answer is always about reality.
 *
 * THREE outcomes, not two: "we could not ask" is not the same as "it is not
 * published", and the UI must not present a network failure as an unpublished
 * file.
 */
export type PublicState = 'published' | 'not-published' | 'unknown'

export async function checkPublished(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicState> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD' })
    if (res.ok) return 'published'
    if (res.status === 404) return 'not-published'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
