// The per-device drive index: the owner's drive events, and what was learned
// opening them, kept on this device so a load fetches only what changed since
// the last sync and decrypts only events it has not opened before.
//
// Nothing changes on the wire: the relay sees the same author-and-kind filter
// as a full read (loadOwnDrive), plus `since` on file events. The drive is
// still built by buildOwnDrive over the whole event set, so deletes (kind 5,
// ring tombstones) and edits from other devices apply exactly as on a full read.
//
// created_at is stamped by the device that wrote the event, so the cursor is
// never this device's clock alone: it is the newest created_at the relay has
// returned, capped at this device's clock. Folder events, key rings (both
// 30079) and kind 5 are few and carry every delete and move, so they are read
// in full on every load; only file events (30078), the bulk, are incremental.
// A file edit stamped more than SYNC_SKEW_SECONDS before the newest event
// waits for the next full read.
//
// A full read never shrinks the stored set on its own word: an event it lacks
// is dropped only when a second full read, CONFIRM_SECONDS later, lacks it
// too. An empty full read is never kept, and the first index on a device is
// read in full once more before loads go incremental.
//
// Events are kept only once their signature checks out and they are by the
// owner (eventVerify): a forged kind 5 must not persist on the device.
//
// At rest the index is one blob per pubkey, encrypted (XChaCha20-Poly1305)
// under a key derived from the root key: it holds names and file keys, which
// must never sit on disk in the clear. Without the root key it is not used.

import type { SignedEvent } from './api'
import { buildOwnDrive, directOpener, fetchAll, type DriveOpener, type DriveSnapshot, type OwnDriveOptions, type QueryFn } from './drive'
import { Crypto } from './crypto'
import { Keys } from './keys'
import { verifiedEvents } from './eventVerify'

const DELETE_KIND = 5
const FILE_KIND = 30078
const FOLDER_KIND = 30079
const DRIVE_KINDS = [DELETE_KIND, FILE_KIND, FOLDER_KIND]
const INDEX_VERSION = 2
const CONTEXT_INDEX = 'cloistr-stash-index-v1'
/** A file event stamped up to this long before the cursor is still fetched (clock skew, slow signers). */
export const SYNC_SKEW_SECONDS = 3600
/** After this long, read everything again: drops what the relay lost without a kind 5. */
export const FULL_SYNC_SECONDS = 86_400
/** When a full read lacked events the index held, read in full again after this long to confirm. */
export const CONFIRM_SECONDS = 3600

/** Where the encrypted index blob lives, one per pubkey. */
export interface DriveIndexStore {
  get(pubkey: string): Promise<Uint8Array | null>
  put(pubkey: string, data: Uint8Array): Promise<void>
  delete(pubkey: string): Promise<void>
}

export class MemoryDriveIndexStore implements DriveIndexStore {
  private blobs = new Map<string, Uint8Array>()
  async get(pubkey: string) {
    return this.blobs.get(pubkey) ?? null
  }
  async put(pubkey: string, data: Uint8Array) {
    this.blobs.set(pubkey, data)
  }
  async delete(pubkey: string) {
    this.blobs.delete(pubkey)
  }
}

export class IndexedDBDriveIndexStore implements DriveIndexStore {
  private db: Promise<IDBDatabase> | null = null

  constructor(
    private dbName = 'cloistr-stash-index',
    private storeName = 'drives',
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.db
  }

  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const req = op(db.transaction(this.storeName, mode).objectStore(this.storeName))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  }

  async get(pubkey: string) {
    const v = await this.run<unknown>('readonly', (s) => s.get(pubkey))
    return v instanceof Uint8Array ? v : null
  }
  async put(pubkey: string, data: Uint8Array) {
    await this.run('readwrite', (s) => s.put(data, pubkey))
  }
  async delete(pubkey: string) {
    await this.run('readwrite', (s) => s.delete(pubkey))
  }
}

interface IndexState {
  v: number
  /** Newest created_at returned, capped at the local clock when that fetch started. */
  cursor: number
  /** Local clock (seconds) of the last full read. */
  fullAt: number
  /** False until a second full read has been compared with the first. */
  confirmed: boolean
  /** Ids the last full read lacked: dropped if the next full read lacks them too. */
  missing: string[]
  events: SignedEvent[]
  /** What opening events gave, by memo key (see memoOpener). */
  memo: Record<string, unknown>
}

// JSON with Uint8Array kept as base64.
const toJSON = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $b: Crypto.bytesToBase64(x) } : x))
const fromJSON = (s: string) =>
  JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$b === 'string' && Object.keys(x).length === 1 ? Crypto.base64ToBytes(x.$b) : x))

const indexKey = (rootKey: Uint8Array, pubkey: string) => Keys.deriveKey(rootKey, pubkey, CONTEXT_INDEX)

async function readIndex(store: DriveIndexStore, pubkey: string, key: Uint8Array): Promise<IndexState | null> {
  try {
    const blob = await store.get(pubkey)
    if (!blob) return null
    const state = fromJSON(new TextDecoder().decode(Crypto.decrypt(blob, key))) as IndexState
    return state.v === INDEX_VERSION && Array.isArray(state.events) && Array.isArray(state.missing) ? state : null
  } catch (err) {
    // Another root key, a damaged blob, or no storage: read in full.
    console.warn('driveIndex: index unreadable, reading the drive in full -', (err as Error).message)
    return null
  }
}

async function writeIndex(store: DriveIndexStore, pubkey: string, key: Uint8Array, state: IndexState): Promise<void> {
  try {
    await store.put(pubkey, Crypto.encrypt(new TextEncoder().encode(toJSON(state)), key))
  } catch (err) {
    console.warn('driveIndex: could not save the index -', (err as Error).message)
  }
}

/** The newest event per kind:d, plus every deletion: all a drive build reads. */
function prune(events: SignedEvent[]): SignedEvent[] {
  const byId = new Map<string, SignedEvent>()
  const latest = new Map<string, SignedEvent>()
  for (const ev of events) {
    if (byId.has(ev.id)) continue
    byId.set(ev.id, ev)
    if (ev.kind === DELETE_KIND) continue
    const d = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (d === undefined) continue
    const addr = `${ev.kind}:${d}`
    const had = latest.get(addr)
    if (!had || ev.created_at > had.created_at || (ev.created_at === had.created_at && ev.id < had.id)) latest.set(addr, ev)
  }
  return [...byId.values()].filter((ev) => ev.kind === DELETE_KIND || latest.get(`${ev.kind}:${ev.tags.find((t) => t[0] === 'd')?.[1]}`) === ev)
}

// A memo key binds the result to the event (its id commits to content and
// tags) and to the key it was opened with. Failures are never remembered.
const keyTag = (key: Uint8Array) => Crypto.bytesToHex(key.subarray(0, 8))

function memoOpener(base: DriveOpener, memo: Record<string, unknown>, used: Set<string>): DriveOpener {
  const remember = async <T>(k: string, open: () => Promise<T>): Promise<T> => {
    used.add(k)
    if (k in memo) return memo[k] as T
    const v = await open()
    memo[k] = v
    return v
  }
  return {
    ring: (ev, key, id) => remember(`r:${ev.id}:${keyTag(key)}:${id}`, () => base.ring(ev, key, id)),
    folder: (ev, key) => remember(`c:${ev.id}:${keyTag(key)}`, () => base.folder(ev, key)),
    file: (ev, key) => remember(`f:${ev.id}:${keyTag(key)}`, () => base.file(ev, key)),
    ringD: (key, id) => remember(`d:${id}:${keyTag(key)}`, () => base.ringD(key, id)),
  }
}

export interface IndexedDriveOptions extends OwnDriveOptions {
  store: DriveIndexStore
  pageSize?: number
  /** Local clock in seconds (tests). */
  now?: () => number
}

/**
 * The owner's drive, as loadOwnDrive gives it, through the device index:
 * fetch what changed (see the top of this file), or everything on the first
 * loads, every FULL_SYNC_SECONDS, and to confirm a short full read; merge;
 * build; save.
 */
export async function loadOwnDriveIndexed(
  query: QueryFn,
  pubkey: string,
  rootKey: Uint8Array | null,
  opts: IndexedDriveOptions,
): Promise<DriveSnapshot> {
  const filter = { kinds: DRIVE_KINDS, authors: [pubkey] }
  if (!rootKey) return buildOwnDrive(await fetchAll(query, filter, opts.pageSize), pubkey, null, opts)

  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))()
  const generation = generations.get(pubkey) ?? 0
  const key = await indexKey(rootKey, pubkey)
  const had = await readIndex(opts.store, pubkey, key)
  // The stored index, when this load may build on it rather than read in full.
  const fullEvery = had?.missing.length ? CONFIRM_SECONDS : FULL_SYNC_SECONDS
  const base = had && had.confirmed && now - had.fullAt < fullEvery ? had : null
  const fullDue = base === null
  const fetched = fullDue
    ? await fetchAll(query, filter, opts.pageSize)
    : (
        await Promise.all([
          fetchAll(query, { kinds: [DELETE_KIND, FOLDER_KIND], authors: [pubkey] }, opts.pageSize),
          fetchAll(query, { kinds: [FILE_KIND], authors: [pubkey], since: base.cursor - SYNC_SKEW_SECONDS }, opts.pageSize),
        ])
      ).flat()
  // Check only what is not already kept: those were checked when stored.
  const known = new Set(had?.events.map((ev) => ev.id))
  const unseen = fetched.filter((ev) => !known.has(ev.id) && ev.pubkey === pubkey)
  const fresh = [...fetched.filter((ev) => known.has(ev.id)), ...(await verifiedEvents(unseen))]

  let events = prune([...(had?.events ?? []), ...fresh])
  const got = new Set(fresh.map((ev) => ev.id))
  let missing = had?.missing.filter((id) => !got.has(id)) ?? []
  if (fullDue && had) {
    const lacking = new Set(events.filter((ev) => !got.has(ev.id)).map((ev) => ev.id))
    const twice = new Set(had.missing.filter((id) => lacking.has(id)))
    events = events.filter((ev) => !twice.has(ev.id))
    missing = [...lacking].filter((id) => !twice.has(id))
  }

  const memo = had?.memo ?? {}
  const used = new Set<string>()
  const opener = memoOpener(opts.opener ?? directOpener, memo, used)
  const unwrapOwner = opts.unwrapOwner
  const drive = await buildOwnDrive(events, pubkey, rootKey, {
    ...opts,
    opener,
    unwrapOwner: unwrapOwner && ((envelope, d) => rememberOwner(memo, used, envelope, d, unwrapOwner)),
  })

  // A first read that is empty gives nothing to keep, and must not become the
  // base. (Emptied by two full reads in a row, it is kept.) Nor is anything
  // written once the index was forgotten (sign-out) while this load ran.
  if ((events.length === 0 && had === null) || (generations.get(pubkey) ?? 0) !== generation) return drive

  // Keep only what this build used: entries for replaced events fall away.
  const kept: Record<string, unknown> = {}
  for (const k of used) if (k in memo) kept[k] = memo[k]
  const newest = events.reduce((m, ev) => Math.max(m, ev.created_at), 0)
  await writeIndex(opts.store, pubkey, key, {
    v: INDEX_VERSION,
    cursor: events.length ? Math.min(now, newest) : now,
    fullAt: base ? base.fullAt : now,
    confirmed: base ? base.confirmed : had !== null,
    missing,
    events,
    memo: kept,
  })
  return drive
}

// Bumped by forgetDriveIndex, so a load already running does not write back.
const generations = new Map<string, number>()

/** Remove an account's index from the device (sign-out, account switch). */
export async function forgetDriveIndex(pubkey: string, store: DriveIndexStore = defaultDriveIndexStore()): Promise<void> {
  generations.set(pubkey, (generations.get(pubkey) ?? 0) + 1)
  try {
    await store.delete(pubkey)
  } catch (err) {
    console.warn('driveIndex: could not remove the index -', (err as Error).message)
  }
}

let defaultStore: IndexedDBDriveIndexStore | null = null
/** The device's index store, shared by the listing and sign-out. */
export function defaultDriveIndexStore(): IndexedDBDriveIndexStore {
  defaultStore ??= new IndexedDBDriveIndexStore()
  return defaultStore
}

// A key opened through owner_key costs a signer call: remember it by d and envelope.
async function rememberOwner(
  memo: Record<string, unknown>,
  used: Set<string>,
  envelope: string,
  d: string,
  unwrap: (envelope: string, d: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const k = `o:${d}:${envelope}`
  used.add(k)
  if (memo[k] instanceof Uint8Array) return memo[k] as Uint8Array
  const key = await unwrap(envelope, d)
  memo[k] = key
  return key
}

