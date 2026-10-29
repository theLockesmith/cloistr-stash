// Reading a drive from the relay (drive interop Phase 1, step 2).
//
// The owner fetches every event of the drive with ONE filter, by author and
// kind, and builds the tree locally from the root key ring down. It never
// queries by #q or #d level by level: that would teach the relay the
// parent-to-child edges the sealed format hides (conscience 2026-10-16).
// A recipient lists one shared folder by its #q plus its ring d, in one REQ.
//
// Old-shape events (clear JSON content and tags) are read alongside the
// sealed ones until the user's drive is migrated.

import type { SignedEvent } from './api'
import type { NostrFilter } from './relay'
import {
  SEALED_FILE_KIND,
  SEALED_FOLDER_KIND,
  folderQ,
  isSealedEvent,
  openFileEvent,
  openFolderEvent,
  openRing,
  ringD,
  rootContainerKey,
  type Ring,
  type RingEntry,
  type SealedFileMeta,
  type SealedFolderMeta,
  type SealedVersion,
} from './sealed'
import type { StashFile, StashFolder } from './types'
import { Keys } from './keys'

/** Sends one REQ carrying these filters and resolves with every event up to EOSE. */
export type QueryFn = (filters: NostrFilter[]) => Promise<SignedEvent[]>

export interface UnreadableItem {
  kind: number
  d: string
  reason: string
}

export interface DriveSnapshot {
  files: StashFile[]
  folders: StashFolder[]
  /** Keys learned from the rings, by file id and folder id. */
  fileKeys: Map<string, Uint8Array>
  folderKeys: Map<string, Uint8Array>
  /** Sealed events that could not be read; never silently dropped. */
  unreadable: UnreadableItem[]
  /**
   * How this drive is written: 'sealed' once its root key ring exists,
   * 'legacy' before that, 'unknown' without the root key (no write may then
   * pick a shape: an old-shape write into a sealed drive would put names in
   * the clear).
   */
  shape: DriveShape
}

export type DriveShape = 'sealed' | 'legacy' | 'unknown'

const DELETE_KIND = 5
const DEFAULT_PAGE = 500
const NOT_DRIVE_FILES = new Set(['root-key', 'cloistr-relays'])

const tag = (ev: SignedEvent, name: string) => ev.tags.find((t) => t[0] === name)?.[1]

/** Newest event per kind:d (NIP-01: on a tie, the lowest id wins). */
function latestByAddress(events: SignedEvent[]): Map<string, SignedEvent> {
  const out = new Map<string, SignedEvent>()
  for (const ev of events) {
    if (ev.kind !== SEALED_FILE_KIND && ev.kind !== SEALED_FOLDER_KIND) continue
    const d = tag(ev, 'd')
    if (d === undefined) continue
    const key = `${ev.kind}:${d}`
    const had = out.get(key)
    if (!had || ev.created_at > had.created_at || (ev.created_at === had.created_at && ev.id < had.id)) out.set(key, ev)
  }
  return out
}

/** kind:d addresses named by the author's own kind-5 deletions. */
function deletedAddresses(events: SignedEvent[], pubkey: string): Set<string> {
  const out = new Set<string>()
  for (const ev of events) {
    if (ev.kind !== DELETE_KIND || ev.pubkey !== pubkey) continue
    for (const t of ev.tags) {
      if (t[0] !== 'a' || !t[1]) continue
      const [kind, author, d] = t[1].split(':', 3)
      if (author === pubkey && d !== undefined) out.add(`${kind}:${d}`)
    }
  }
  return out
}

function parseJSON(content: string): Record<string, unknown> {
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// Old-shape file event, read as the Go server's ParseFileEvent did.
function legacyFile(ev: SignedEvent): StashFile | null {
  const d = tag(ev, 'd')
  const sha256 = tag(ev, 'x')
  if (!d || !sha256 || NOT_DRIVE_FILES.has(d)) return null
  const c = parseJSON(ev.content)
  const deletedAt = Number(tag(ev, 'deleted_at') ?? c.deleted_at ?? 0) || undefined
  const size = Number(tag(ev, 'size') ?? c.size ?? 0)
  return {
    sha256,
    id: d,
    file_id: d,
    name: typeof c.name === 'string' ? c.name : '',
    size,
    mime_type: tag(ev, 'm') ?? (c.mime_type as string | undefined),
    encrypted_size: typeof c.encrypted_size === 'number' ? c.encrypted_size : undefined,
    encrypted: Boolean(tag(ev, 'encrypted') ?? c.encrypted),
    encryption: tag(ev, 'encrypted'),
    plaintext_hash: tag(ev, 'ox'),
    folder: tag(ev, 'folder') ?? '',
    folder_id: tag(ev, 'folder') ?? '',
    deleted_at: deletedAt,
    tags: ev.tags.filter((t) => t[0] === 't').map((t) => t[1]),
    owner_key: tag(ev, 'owner_key'),
    created_at: ev.created_at,
    versions: versionTags(ev),
    sealed: false,
  }
}

// An old-shape file's versions: its ['v', sha256, version, createdAt, pubkey] tags.
function versionTags(ev: SignedEvent): SealedVersion[] {
  return ev.tags
    .filter((t) => t[0] === 'v' && t[1])
    .map((t) => ({ sha256: t[1], version: Number(t[2]) || 0, createdAt: Number(t[3]) || 0 }))
}

function legacyFolder(ev: SignedEvent): StashFolder | null {
  const d = tag(ev, 'd')
  if (!d) return null
  const c = parseJSON(ev.content)
  return {
    id: d,
    name: typeof c.name === 'string' ? c.name : '',
    description: typeof c.description === 'string' ? c.description : undefined,
    parent_id: tag(ev, 'parent'),
    encrypted_key: tag(ev, 'key'),
    wrapped_keys: ev.tags.filter((t) => t[0] === 'wk' && t.length >= 3).map((t) => ({ subject: t[1], envelope: t[2] })),
    created_at: ev.created_at,
    sealed: false,
  }
}

/**
 * How sealed events are opened while building a drive. The default decrypts
 * every time; the drive index (driveIndex.ts) remembers what it has opened.
 */
export interface DriveOpener {
  ring(ev: SignedEvent, folderKey: Uint8Array, folderId: string): Promise<Ring>
  folder(ev: SignedEvent, folderKey: Uint8Array): Promise<SealedFolderMeta>
  file(ev: SignedEvent, fileKey: Uint8Array): Promise<SealedFileMeta>
  /** The d of a folder's key ring (an HKDF per folder). */
  ringD(folderKey: Uint8Array, folderId: string): Promise<string>
}

export const directOpener: DriveOpener = { ring: openRing, folder: openFolderEvent, file: openFileEvent, ringD }

interface Container {
  id: string
  key: Uint8Array
}

/**
 * Walk sealed rings from `start`, opening every folder, file and child ring
 * reachable with the keys found on the way. `bySealedD` maps kind:d to the
 * newest sealed event.
 */
async function walkRings(
  start: Container[],
  bySealedD: Map<string, SignedEvent>,
  deleted: Set<string>,
  snap: DriveSnapshot,
  reached: Set<string>,
  tombstoned: Set<string> = new Set(),
  opener: DriveOpener = directOpener,
): Promise<void> {
  const queue = [...start]
  const seen = new Set<string>()
  const pendingFiles: RingEntry[] = []

  while (queue.length) {
    const c = queue.shift()!
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const rd = await opener.ringD(c.key, c.id)
    const ringEv = bySealedD.get(`${SEALED_FOLDER_KIND}:${rd}`)
    if (!ringEv) continue
    reached.add(`${SEALED_FOLDER_KIND}:${rd}`)
    let ring
    try {
      ring = await opener.ring(ringEv, c.key, c.id)
    } catch (err) {
      snap.unreadable.push({ kind: SEALED_FOLDER_KIND, d: rd, reason: (err as Error).message })
      continue
    }
    for (const t of ring.tombstones) tombstoned.add(t.d)
    for (const f of ring.folders) {
      const addr = `${SEALED_FOLDER_KIND}:${f.d}`
      const ev = bySealedD.get(addr)
      if (!ev || deleted.has(addr) || tombstoned.has(f.d)) continue
      reached.add(addr)
      try {
        const meta = await opener.folder(ev, f.key)
        if (meta.id !== f.id) throw new Error('folder id differs from its ring entry')
        snap.folders.push({
          id: meta.id,
          name: meta.name,
          description: meta.description,
          parent_id: meta.parentId ?? undefined,
          created_at: ev.created_at,
          d: f.d,
          sealed: true,
        })
        snap.folderKeys.set(meta.id, f.key)
        queue.push({ id: meta.id, key: f.key })
      } catch (err) {
        snap.unreadable.push({ kind: SEALED_FOLDER_KIND, d: f.d, reason: (err as Error).message })
      }
    }
    pendingFiles.push(...ring.files)
  }

  // Files after every ring is open, so a tombstone in any ring applies.
  // A file can sit in two rings after a move; its own content places it.
  const done = new Set<string>()
  for (const f of pendingFiles) {
    const addr = `${SEALED_FILE_KIND}:${f.d}`
    if (done.has(f.d)) continue
    const ev = bySealedD.get(addr)
    if (!ev || deleted.has(addr) || tombstoned.has(f.d)) {
      if (ev) reached.add(addr)
      continue
    }
    done.add(f.d)
    reached.add(addr)
    try {
      const m = await opener.file(ev, f.key)
      if (m.id !== f.id) throw new Error('file id differs from its ring entry')
      pushSealedFile(snap, ev, f.d, f.key, m)
    } catch (err) {
      snap.unreadable.push({ kind: SEALED_FILE_KIND, d: f.d, reason: (err as Error).message })
    }
  }
}

function pushSealedFile(snap: DriveSnapshot, ev: SignedEvent, d: string, key: Uint8Array, m: SealedFileMeta): void {
  snap.files.push({
    sha256: m.sha256,
    id: m.id,
    file_id: m.id,
    name: m.name,
    size: m.size,
    mime_type: m.mimeType,
    encrypted_size: m.encryptedSize,
    encrypted: true,
    plaintext_hash: m.plaintextHash,
    folder: m.folderId ?? '',
    folder_id: m.folderId ?? '',
    deleted_at: m.deletedAt,
    tags: m.userTags ?? [],
    versions: m.versions,
    owner_key: tag(ev, 'owner_key'),
    created_at: ev.created_at,
    d,
    sealed: true,
  })
  snap.fileKeys.set(m.id, key)
}

function emptySnapshot(): DriveSnapshot {
  return { files: [], folders: [], fileKeys: new Map(), folderKeys: new Map(), unreadable: [], shape: 'unknown' }
}

export interface OwnDriveOptions {
  /**
   * Opens a sealed file's owner_key envelope (bound to the event's d). Used
   * only for files no ring reaches, e.g. a ring entry lost to a two-device
   * race, so the owner never loses a file to one. One signer call each.
   */
  unwrapOwner?: (envelope: string, d: string) => Promise<Uint8Array>
  /** Opens sealed events; directOpener unless given. */
  opener?: DriveOpener
}

/** Build the owner's drive from every event they authored (kinds 5, 30078, 30079). */
// Without the root key (signer unavailable), old-shape items still list and
// every sealed one is reported unreadable rather than dropped.
export async function buildOwnDrive(
  events: SignedEvent[],
  pubkey: string,
  rootKey: Uint8Array | null,
  opts: OwnDriveOptions = {},
): Promise<DriveSnapshot> {
  const snap = emptySnapshot()
  const own = events.filter((e) => e.pubkey === pubkey)
  const latest = latestByAddress(own)
  const deleted = deletedAddresses(own, pubkey)

  const sealed = new Map<string, SignedEvent>()
  for (const [addr, ev] of latest) {
    // The root key and relay preferences share kind 30078 but are not drive items.
    if (NOT_DRIVE_FILES.has(tag(ev, 'd')!)) continue
    if (isSealedEvent(ev)) {
      sealed.set(addr, ev)
      continue
    }
    if (deleted.has(addr)) continue
    if (ev.kind === SEALED_FILE_KIND) {
      const f = legacyFile(ev)
      if (f) snap.files.push(f)
    } else {
      const f = legacyFolder(ev)
      if (f) snap.folders.push(f)
    }
  }

  const reached = new Set<string>()
  const tombstoned = new Set<string>()
  if (rootKey) {
    const rootCK = await rootContainerKey(rootKey)
    // Sealed drive items (they carry q) with no root ring: the relay has lost
    // or withheld the ring. Not 'legacy', or the next write would put names
    // in the clear. Other apps' non-JSON kind 30078 events carry no q.
    snap.shape = sealed.has(`${SEALED_FOLDER_KIND}:${await ringD(rootCK, '')}`)
      ? 'sealed'
      : [...sealed.values()].some((ev) => tag(ev, 'q'))
        ? 'unknown'
        : 'legacy'
    await walkRings([{ id: '', key: rootCK }], sealed, deleted, snap, reached, tombstoned, opts.opener)
  }
  const reason = rootKey ? 'not in any key ring' : 'root key unavailable'
  for (const [addr, ev] of sealed) {
    // A stray ring or folder event is noise; a file no ring reaches is a lost
    // file. Every sealed file carries q: an event without one is not ours
    // (other apps use kind 30078 too, with any content).
    if (reached.has(addr) || deleted.has(addr) || ev.kind !== SEALED_FILE_KIND || !tag(ev, 'q')) continue
    const d = tag(ev, 'd')!
    // Deleted (a ring tombstone), though the relay kept the event despite the kind 5.
    if (tombstoned.has(d)) continue
    const envelope = tag(ev, 'owner_key')
    // Only with the root key: without it no ring was read, and every sealed
    // file would cost a signer call that is likely failing too.
    if (rootKey && envelope && opts.unwrapOwner) {
      try {
        const key = await opts.unwrapOwner(envelope, d)
        pushSealedFile(snap, ev, d, key, await (opts.opener ?? directOpener).file(ev, key))
        continue
      } catch (err) {
        snap.unreadable.push({ kind: ev.kind, d, reason: `${reason}; owner_key: ${(err as Error).message}` })
        continue
      }
    }
    snap.unreadable.push({ kind: ev.kind, d, reason })
  }
  return snap
}

/**
 * Every event matching `filter`, paged backwards with `until`. A relay may
 * cap a page below `pageSize`, so a short page does not mean the end: paging
 * stops only when a page adds nothing new. If that page is as long as the
 * relay's proven cap (an earlier page of that length was followed by more),
 * it may be one second holding more events than one REQ returns; that is
 * thrown, never returned as a complete drive (cloistr-pr review of !193).
 * A page that adds nothing but is as long as the limit asked for is the same
 * case on the first page, before any cap is proven. Its one false alarm is a
 * drive of exactly `pageSize` events all in one second. Blind spot: a relay
 * that caps below `pageSize` on a first page that is all one second cannot be
 * told apart from a complete answer.
 */
export async function fetchAll(query: QueryFn, filter: NostrFilter, pageSize = DEFAULT_PAGE): Promise<SignedEvent[]> {
  const byId = new Map<string, SignedEvent>()
  let until: number | undefined
  let cap = 0
  let capProven = false
  let lastLength = 0
  for (;;) {
    const page = await query([{ ...filter, limit: pageSize, ...(until === undefined ? {} : { until }) }])
    let added = 0
    for (const ev of page) {
      if (!byId.has(ev.id)) {
        byId.set(ev.id, ev)
        added++
      }
    }
    if (added === 0) {
      if (page.length > 0 && (page.length >= pageSize || (capProven && page.length >= cap))) {
        throw new Error(`the drive could not be read in full: more events share one second than the relay returns per request (${page.length})`)
      }
      break
    }
    // The previous page was followed by new events: its length is a real cap.
    if (lastLength > 0 && lastLength >= cap) capProven = true
    cap = Math.max(cap, page.length)
    lastLength = page.length
    // Inclusive of the oldest second, so events sharing it are not skipped;
    // the id map drops the repeats.
    until = Math.min(...page.map((e) => e.created_at))
  }
  return [...byId.values()]
}

/** The owner's drive: one filter by author and kind, the tree built locally. */
export async function loadOwnDrive(
  query: QueryFn,
  pubkey: string,
  rootKey: Uint8Array | null,
  opts: OwnDriveOptions & { pageSize?: number } = {},
): Promise<DriveSnapshot> {
  const events = await fetchAll(
    query,
    { kinds: [DELETE_KIND, SEALED_FILE_KIND, SEALED_FOLDER_KIND], authors: [pubkey] },
    opts.pageSize ?? DEFAULT_PAGE,
  )
  return buildOwnDrive(events, pubkey, rootKey, opts)
}

/**
 * One folder someone shared with us: its files and child folders, from one
 * REQ by the folder's #q and its ring d. Child folders come back with their
 * keys, so opening one is the same call again.
 */
export async function listSharedFolder(
  query: QueryFn,
  owner: string,
  folderId: string,
  folderKey: Uint8Array,
): Promise<DriveSnapshot> {
  const snap = emptySnapshot()
  const [q, rd] = await Promise.all([folderQ(folderKey, folderId), ringD(folderKey, folderId)])
  const events = await query([
    { kinds: [SEALED_FILE_KIND, SEALED_FOLDER_KIND], authors: [owner], '#q': [q] },
    { kinds: [SEALED_FOLDER_KIND], authors: [owner], '#d': [rd] },
  ])
  const sealed = new Map<string, SignedEvent>()
  for (const [addr, ev] of latestByAddress(events.filter((e) => e.pubkey === owner))) {
    if (isSealedEvent(ev)) sealed.set(addr, ev)
  }
  // Only this level: walk the shared folder's ring without descending.
  const one = emptySnapshot()
  await walkRings([{ id: folderId, key: folderKey }], sealed, new Set(), one, new Set())
  snap.files = one.files.filter((f) => f.folder_id === folderId)
  snap.folders = one.folders.filter((f) => f.parent_id === folderId)
  for (const f of snap.files) snap.fileKeys.set(f.id!, one.fileKeys.get(f.id!)!)
  for (const f of snap.folders) snap.folderKeys.set(f.id, one.folderKeys.get(f.id)!)
  snap.unreadable = one.unreadable
  await addLegacyLevel(query, owner, folderId, folderKey, snap)
  return snap
}

/**
 * The old-shape part of a shared folder (drives not yet migrated): the
 * owner's file events whose LATEST version is in `folderId`, and the folders
 * directly under it. A file lists only when the shared folder key reaches its
 * key: a 'wk' entry on the folder event that unwraps under it (wrapped-key
 * file), or HKDF from it (pre-wrapping file, no owner_key). A wrapped file
 * without such an entry is never listed on its folder tag alone. Old-shape
 * child folders are not listed: their keys are random and wrapped to the
 * owner only (Keys.generateFolderKey), so the shared key cannot reach them.
 */
async function addLegacyLevel(
  query: QueryFn,
  owner: string,
  folderId: string,
  folderKey: Uint8Array,
  snap: DriveSnapshot,
): Promise<void> {
  const [events, folderEvents] = await Promise.all([
    fetchAll(query, { kinds: [DELETE_KIND, SEALED_FILE_KIND], authors: [owner] }),
    query([{ kinds: [SEALED_FOLDER_KIND], authors: [owner] }]),
  ])
  const mine = [...events, ...folderEvents].filter((e) => e.pubkey === owner)
  const deleted = deletedAddresses(mine, owner)
  const latest = latestByAddress(mine)
  const listed = new Set(snap.files.map((f) => f.id))

  const shared = latest.get(`${SEALED_FOLDER_KIND}:${folderId}`)
  const wrapped = shared && !isSealedEvent(shared) ? (legacyFolder(shared)?.wrapped_keys ?? []) : []

  for (const [addr, ev] of latest) {
    if (isSealedEvent(ev) || deleted.has(addr)) continue
    if (ev.kind === SEALED_FILE_KIND) {
      const f = legacyFile(ev)
      if (!f || f.folder_id !== folderId || f.deleted_at || listed.has(f.id)) continue
      let key: Uint8Array
      if (f.owner_key) {
        const entry = wrapped.find((w) => w.subject === f.id)
        if (!entry) continue
        try {
          key = Keys.unwrapFileKeyFromFolder(entry.envelope as Parameters<typeof Keys.unwrapFileKeyFromFolder>[0], f.id!, folderKey)
        } catch (err) {
          snap.unreadable.push({ kind: SEALED_FILE_KIND, d: f.id!, reason: (err as Error).message })
          continue
        }
      } else {
        key = await Keys.deriveKey(folderKey, f.id!, Keys.CONTEXT_FILE)
      }
      snap.files.push(f)
      snap.fileKeys.set(f.id!, key)
    }
  }
}
