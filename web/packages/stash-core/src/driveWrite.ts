// Writing a sealed drive (drive interop Phase 1, step 4). Plan:
// specs/drive-interop-phase1/plan.md, "Format" and step 4.
//
// Every write keeps the format's rules:
//   - a file event is sealed under its own key, a folder event under the
//     folder's own key; only d, q (and a file's owner_key) are in the clear
//   - new folder keys are random, never derived; each child (file or folder)
//     is a wrapped entry in its container's key ring
//   - every ring write is read-merge-write, and checked after publishing: if
//     another device's ring replaced ours, the change is merged onto theirs
//     and published again
//   - a move republishes the item under its new q and moves its ring entry; a
//     stale entry left by a race loses to the file's own content (reader)
//   - a permanent delete is a kind 5 of the item event plus a ring tombstone
//
// The owner_key envelope on a sealed file is bound to the event's d, not the
// file id: the id is inside the seal, so a binding to it could only be opened
// by someone who already holds the key. It is the owner's fallback when a ring
// entry is lost (buildOwnDrive's unwrapOwner).
//
// Nothing here decides WHEN a drive is written sealed; see isSealedDrive.

import type { SignedEvent } from './api'
import { Crypto } from './crypto'
import type { QueryFn } from './drive'
import type { UnsignedEvent } from './relay'
import {
  SEALED_FILE_KIND,
  SEALED_FOLDER_KIND,
  folderQ,
  openFileEvent,
  openFolderEvent,
  openRing,
  randomD,
  ringD,
  rootContainerKey,
  sealFileEvent,
  sealFolderEvent,
  sealRing,
  type Ring,
  type RingEntry,
  type SealedFileMeta,
  type SealedFolderMeta,
} from './sealed'

const DELETE_KIND = 5
/** Publish attempts for one ring change when other writers keep replacing the ring. */
const RING_ATTEMPTS = 3

export interface WritePorts {
  pubkey: string
  /** One REQ, every event up to EOSE (rejects on timeout; [] only after EOSE). */
  query: QueryFn
  /** Sign and publish; resolves with the signed event once the relay accepted it. */
  publish: (ev: UnsignedEvent) => Promise<SignedEvent>
  /** The owner envelope for a key, bound to `subject` (NIP-44 to the owner's own pubkey). */
  wrapForOwner: (key: Uint8Array, subject: string) => Promise<string>
}

export interface WriteContext extends WritePorts {
  rootKey: Uint8Array
  /** Folder keys learned from the rings (DriveSnapshot.folderKeys), by folder id. */
  folderKeys: Map<string, Uint8Array>
}

/** An item as its container's ring holds it: event d, id and key. */
export type ItemRef = RingEntry

export class SealedWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealedWriteError'
  }
}

const now = () => Math.floor(Date.now() / 1000)

/** The container's key: the root container for '' or null, else the folder's key from the rings. */
async function containerKey(ctx: WriteContext, folderId: string | null): Promise<Uint8Array> {
  if (!folderId) return rootContainerKey(ctx.rootKey)
  const key = ctx.folderKeys.get(folderId)
  if (!key) throw new SealedWriteError(`no key for folder ${folderId}; reload the drive and try again`)
  return key
}

/** The newest of the owner's events for (kind, d), or null when the relay has none. */
async function latest(ctx: WritePorts, kind: number, d: string): Promise<SignedEvent | null> {
  const events = await ctx.query([{ kinds: [kind], authors: [ctx.pubkey], '#d': [d] }])
  let best: SignedEvent | null = null
  for (const ev of events) {
    if (ev.pubkey !== ctx.pubkey || ev.kind !== kind) continue
    if (!best || ev.created_at > best.created_at || (ev.created_at === best.created_at && ev.id < best.id)) best = ev
  }
  return best
}

/** Publish `ev` strictly newer than `prev`, so it replaces it even with clock skew. */
function after(ev: UnsignedEvent, prev: { created_at: number } | null): UnsignedEvent {
  return { ...ev, created_at: Math.max(now(), (prev?.created_at ?? 0) + 1) }
}

const upsert = (list: RingEntry[], e: RingEntry) => [...list.filter((x) => x.d !== e.d), e]
const without = (list: RingEntry[], d: string) => list.filter((x) => x.d !== d)

/**
 * Read-merge-write one container's ring. `change` must be idempotent: it is
 * applied again on top of any ring another writer published in between.
 */
async function updateRing(ctx: WriteContext, folderId: string | null, change: (ring: Ring) => Ring): Promise<void> {
  const id = folderId ?? ''
  const key = await containerKey(ctx, folderId)
  const d = await ringD(key, id)
  for (let attempt = 1; attempt <= RING_ATTEMPTS; attempt++) {
    const current = await latest(ctx, SEALED_FOLDER_KIND, d)
    const ring = current ? await openRing(current, key, id) : { files: [], folders: [], tombstones: [] }
    const next = change(ring)
    const mine = await ctx.publish(after(await sealRing({ folderKey: key, folderId: id, ...next }), current))
    // Another device may have replaced the ring between our read and write.
    const check = await latest(ctx, SEALED_FOLDER_KIND, d)
    if (!check || check.id === mine.id) return
  }
  throw new SealedWriteError('the folder kept changing on another device; reload and try again')
}

/** Whether this drive is written sealed: its root key ring exists (the migration, or a new drive, made it). */
export async function isSealedDrive(ports: WritePorts, rootKey: Uint8Array): Promise<boolean> {
  const d = await ringD(await rootContainerKey(rootKey), '')
  return (await latest(ports, SEALED_FOLDER_KIND, d)) !== null
}

// ── Files ────────────────────────────────────────────────────────────────

/**
 * Add a file whose blob is already uploaded, encrypted with `key`. Publishes
 * the file event first (with its owner envelope, so the owner never loses it),
 * then the container's ring entry.
 */
export async function addFile(
  ctx: WriteContext,
  args: { key: Uint8Array; meta: SealedFileMeta },
): Promise<ItemRef> {
  const ref: ItemRef = { d: randomD(), id: args.meta.id, key: args.key }
  const folderId = args.meta.folderId || null
  const q = await folderQ(await containerKey(ctx, folderId), folderId ?? '')
  const ownerEnvelope = await ctx.wrapForOwner(ref.key, ref.d)
  await ctx.publish(await sealFileEvent({ d: ref.d, q, fileKey: ref.key, meta: { ...args.meta, folderId }, ownerEnvelope }))
  await updateRing(ctx, folderId, (r) => ({ ...r, files: upsert(r.files, ref) }))
  return ref
}

/**
 * Change a file's sealed metadata: rename, trash or restore (deletedAt), tags,
 * a new version, or a move (folderId). The change applies to the file's
 * CURRENT event; nothing is published unless it loaded and opened. A move
 * republishes under the new folder's q and moves the ring entry.
 */
export async function updateFile(
  ctx: WriteContext,
  ref: ItemRef,
  change: (meta: SealedFileMeta) => SealedFileMeta,
): Promise<SealedFileMeta> {
  const current = await latest(ctx, SEALED_FILE_KIND, ref.d)
  if (!current) throw new SealedWriteError('the relay has no record of this file; nothing was changed')
  const meta = await openFileEvent(current, ref.key)
  if (meta.id !== ref.id) throw new SealedWriteError('file record does not match its key ring entry')
  const next = { ...change({ ...meta }), id: meta.id }
  const from = meta.folderId || null
  const to = next.folderId || null
  next.folderId = to
  // Wrapped afresh, never copied from the relay's copy: the relay client does
  // not verify signatures, so a relay could hand back a broken envelope that
  // every later edit would then keep.
  const ownerEnvelope = await ctx.wrapForOwner(ref.key, ref.d)
  const q = await folderQ(await containerKey(ctx, to), to ?? '')
  await ctx.publish(after(await sealFileEvent({ d: ref.d, q, fileKey: ref.key, meta: next, ownerEnvelope }), current))
  if (from !== to) {
    await updateRing(ctx, to, (r) => ({ ...r, files: upsert(r.files, ref) }))
    await updateRing(ctx, from, (r) => ({ ...r, files: without(r.files, ref.d) }))
  }
  return next
}

/** Record a new version: the blob changes, the key does not (same as the old shape). */
export function withNewVersion(
  meta: SealedFileMeta,
  blob: { sha256: string; size: number; encryptedSize: number; plaintextHash?: string },
  at = now(),
): SealedFileMeta {
  const versions = meta.versions?.length
    ? [...meta.versions]
    : [{ sha256: meta.sha256, version: 1, createdAt: at }]
  versions.push({ sha256: blob.sha256, version: versions.length + 1, createdAt: at })
  return { ...meta, ...blob, versions }
}

/** Delete a file for good: kind 5 of its event, and a tombstone in its container's ring. */
export async function deleteFile(ctx: WriteContext, ref: Pick<ItemRef, 'd'>, folderId: string | null): Promise<void> {
  await ctx.publish(deletion(ctx.pubkey, [`${SEALED_FILE_KIND}:${ref.d}`]))
  await updateRing(ctx, folderId || null, (r) => ({
    ...r,
    files: without(r.files, ref.d),
    tombstones: r.tombstones.some((t) => t.d === ref.d) ? r.tombstones : [...r.tombstones, { d: ref.d, deletedAt: now() }],
  }))
}

// ── Folders ──────────────────────────────────────────────────────────────

/** A new folder under `parentId` (null = root), with a random key wrapped in the parent's ring. */
export async function createFolder(
  ctx: WriteContext,
  args: { id: string; name: string; parentId: string | null; description?: string },
): Promise<ItemRef> {
  await Crypto.init()
  const ref: ItemRef = { d: randomD(), id: args.id, key: Crypto.generateKey() }
  const parentId = args.parentId || null
  const q = await folderQ(await containerKey(ctx, parentId), parentId ?? '')
  const meta: SealedFolderMeta = { id: args.id, name: args.name, parentId, description: args.description }
  await ctx.publish(await sealFolderEvent({ d: ref.d, q, folderKey: ref.key, meta }))
  await updateRing(ctx, parentId, (r) => ({ ...r, folders: upsert(r.folders, ref) }))
  // From here on its children are written with this key.
  ctx.folderKeys.set(ref.id, ref.key)
  return ref
}

/** Rename a folder (or change its description) on its CURRENT event. */
export async function updateFolder(
  ctx: WriteContext,
  ref: ItemRef,
  change: (meta: SealedFolderMeta) => SealedFolderMeta,
): Promise<SealedFolderMeta> {
  const current = await latest(ctx, SEALED_FOLDER_KIND, ref.d)
  if (!current) throw new SealedWriteError('the relay has no record of this folder; nothing was changed')
  const meta = await openFolderEvent(current, ref.key)
  if (meta.id !== ref.id) throw new SealedWriteError('folder record does not match its key ring entry')
  const next = { ...change({ ...meta }), id: meta.id, parentId: meta.parentId }
  const q = current.tags.find((t) => t[0] === 'q')?.[1]
  if (!q) throw new SealedWriteError('folder record has no q')
  await ctx.publish(after(await sealFolderEvent({ d: ref.d, q, folderKey: ref.key, meta: next }), current))
  return next
}

/**
 * Delete a folder and everything under it: one kind 5 naming the folder's
 * event, its ring and every descendant's event and ring, then a tombstone in
 * the parent's ring. `subtree` is what the caller's snapshot holds under the
 * folder; anything it missed becomes unreachable once the folder is gone.
 */
export async function deleteFolder(
  ctx: WriteContext,
  ref: ItemRef,
  parentId: string | null,
  subtree: { folders: ItemRef[]; files: ItemRef[] },
): Promise<void> {
  const addrs: string[] = []
  for (const f of [ref, ...subtree.folders]) {
    addrs.push(`${SEALED_FOLDER_KIND}:${f.d}`, `${SEALED_FOLDER_KIND}:${await ringD(f.key, f.id)}`)
  }
  for (const f of subtree.files) addrs.push(`${SEALED_FILE_KIND}:${f.d}`)
  await ctx.publish(deletion(ctx.pubkey, addrs))
  await updateRing(ctx, parentId || null, (r) => ({
    ...r,
    folders: without(r.folders, ref.d),
    tombstones: r.tombstones.some((t) => t.d === ref.d) ? r.tombstones : [...r.tombstones, { d: ref.d, deletedAt: now() }],
  }))
  for (const f of [ref, ...subtree.folders]) ctx.folderKeys.delete(f.id)
}

function deletion(pubkey: string, addrs: string[]): UnsignedEvent {
  return {
    kind: DELETE_KIND,
    created_at: now(),
    tags: addrs.map((a) => {
      const [kind, d] = a.split(':')
      return ['a', `${kind}:${pubkey}:${d}`]
    }),
    content: '',
  }
}
