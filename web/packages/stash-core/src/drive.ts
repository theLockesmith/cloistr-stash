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
  type RingEntry,
} from './sealed'
import type { StashFile, StashFolder } from './types'

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
}

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
    sealed: false,
  }
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
): Promise<void> {
  const queue = [...start]
  const seen = new Set<string>()
  const tombstoned = new Set<string>()
  const pendingFiles: RingEntry[] = []

  while (queue.length) {
    const c = queue.shift()!
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const rd = await ringD(c.key, c.id)
    const ringEv = bySealedD.get(`${SEALED_FOLDER_KIND}:${rd}`)
    if (!ringEv) continue
    reached.add(`${SEALED_FOLDER_KIND}:${rd}`)
    let ring
    try {
      ring = await openRing(ringEv, c.key, c.id)
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
        const meta = await openFolderEvent(ev, f.key)
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
      const m = await openFileEvent(ev, f.key)
      if (m.id !== f.id) throw new Error('file id differs from its ring entry')
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
        d: f.d,
        sealed: true,
      })
      snap.fileKeys.set(m.id, f.key)
    } catch (err) {
      snap.unreadable.push({ kind: SEALED_FILE_KIND, d: f.d, reason: (err as Error).message })
    }
  }
}

function emptySnapshot(): DriveSnapshot {
  return { files: [], folders: [], fileKeys: new Map(), folderKeys: new Map(), unreadable: [] }
}

/** Build the owner's drive from every event they authored (kinds 5, 30078, 30079). */
// Without the root key (signer unavailable), old-shape items still list and
// every sealed one is reported unreadable rather than dropped.
export async function buildOwnDrive(
  events: SignedEvent[],
  pubkey: string,
  rootKey: Uint8Array | null,
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
  if (rootKey) {
    await walkRings([{ id: '', key: await rootContainerKey(rootKey) }], sealed, deleted, snap, reached)
  }
  const reason = rootKey ? 'not in any key ring' : 'root key unavailable'
  for (const [addr, ev] of sealed) {
    // A stray ring or folder event is noise; a file no ring reaches is a lost
    // file. Every sealed file carries q: an event without one is not ours
    // (other apps use kind 30078 too, with any content).
    if (reached.has(addr) || deleted.has(addr) || ev.kind !== SEALED_FILE_KIND || !tag(ev, 'q')) continue
    snap.unreadable.push({ kind: ev.kind, d: tag(ev, 'd')!, reason })
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
  opts: { pageSize?: number } = {},
): Promise<DriveSnapshot> {
  const events = await fetchAll(
    query,
    { kinds: [DELETE_KIND, SEALED_FILE_KIND, SEALED_FOLDER_KIND], authors: [pubkey] },
    opts.pageSize ?? DEFAULT_PAGE,
  )
  return buildOwnDrive(events, pubkey, rootKey)
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
  return snap
}
