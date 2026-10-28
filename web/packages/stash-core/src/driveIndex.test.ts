// The per-device drive index: decrypt once, keep it (encrypted) on the device,
// then fetch only what changed. It must give exactly the drive a full read
// gives, including deletes and edits made on other devices.
import { beforeAll, describe, it, expect } from 'vitest'
import { loadOwnDrive, type DriveOpener, type QueryFn } from './drive'
import { loadOwnDriveIndexed, MemoryDriveIndexStore, SYNC_SKEW_SECONDS } from './driveIndex'
import {
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
  type SealedFileMeta,
} from './sealed'
import type { SignedEvent } from './api'
import type { NostrFilter, UnsignedEvent } from './relay'
import { Crypto } from './crypto'

const OWNER = 'a'.repeat(64)
const ROOT = new Uint8Array(32).fill(1)
const k = (n: number) => new Uint8Array(32).fill(n)
const T0 = 1_760_000_000

let seq = 0
function signed(ev: UnsignedEvent, createdAt = T0): SignedEvent {
  seq++
  return { ...ev, created_at: createdAt, pubkey: OWNER, id: seq.toString(16).padStart(64, '0'), sig: '' }
}

const fileMeta = (id: string, name: string, folderId: string | null): SealedFileMeta => ({
  id,
  name,
  folderId,
  sha256: id.repeat(2).slice(0, 64).padEnd(64, '0'),
  size: 10,
  mimeType: 'text/plain',
})

const legacyFile = (d: string, name: string, createdAt = T0): SignedEvent =>
  signed(
    {
      kind: 30078,
      created_at: 0,
      tags: [['d', d], ['x', 'e'.repeat(64)], ['m', 'text/plain'], ['size', '42']],
      content: JSON.stringify({ name, size: 42 }),
    },
    createdAt,
  )

/** A relay over `events`: honours kinds, authors, since, until and limit, newest first. */
function fakeRelay(events: SignedEvent[]) {
  const filters: NostrFilter[] = []
  const query: QueryFn = async (fs) => {
    filters.push(...fs)
    const out: SignedEvent[] = []
    for (const raw of fs) {
      const f = raw as { kinds?: number[]; authors?: string[]; since?: number; until?: number; limit?: number }
      const hit = events
        .filter((e) => !f.kinds || f.kinds.includes(e.kind))
        .filter((e) => !f.authors || f.authors.includes(e.pubkey))
        .filter((e) => f.since === undefined || e.created_at >= f.since)
        .filter((e) => f.until === undefined || e.created_at <= f.until)
        .sort((a, b) => b.created_at - a.created_at)
      out.push(...hit.slice(0, f.limit ?? hit.length))
    }
    return out
  }
  return { query, filters, events }
}

function countingOpener() {
  const calls = { ring: 0, folder: 0, file: 0 }
  const opener: DriveOpener = {
    ring: (ev, key, id) => (calls.ring++, openRing(ev, key, id)),
    folder: (ev, key) => (calls.folder++, openFolderEvent(ev, key)),
    file: (ev, key) => (calls.file++, openFileEvent(ev, key)),
    ringD,
  }
  return { opener, calls }
}

// Root: file r1 and folder A. A: file a1.
async function sampleDrive() {
  const rootCK = await rootContainerKey(ROOT)
  const A = { id: 'a1'.padEnd(32, '0'), key: k(2), d: randomD() }
  const r1 = { id: 'f1'.padEnd(32, '0'), key: k(4), d: randomD() }
  const a1 = { id: 'f2'.padEnd(32, '0'), key: k(5), d: randomD() }
  const rootRing = (files = [r1], createdAt = T0) =>
    sealRing({ folderKey: rootCK, folderId: '', files, folders: [A], tombstones: [] }).then((e) => signed(e, createdAt))
  const aRing = async (tombstones: { d: string; deletedAt: number }[] = [], createdAt = T0) =>
    signed(await sealRing({ folderKey: A.key, folderId: A.id, files: [a1], folders: [], tombstones }), createdAt)
  const r1Event = async (name: string, createdAt = T0) =>
    signed(await sealFileEvent({ d: r1.d, q: await folderQ(rootCK, ''), fileKey: r1.key, meta: fileMeta(r1.id, name, null) }), createdAt)
  const events: SignedEvent[] = [
    await rootRing(),
    await aRing(),
    signed(await sealFolderEvent({ d: A.d, q: await folderQ(rootCK, ''), folderKey: A.key, meta: { id: A.id, name: 'Alpha', parentId: null } })),
    await r1Event('root.txt'),
    signed(await sealFileEvent({ d: a1.d, q: await folderQ(A.key, A.id), fileKey: a1.key, meta: fileMeta(a1.id, 'alpha.txt', A.id) })),
  ]
  return { events, A, r1, a1, aRing, r1Event }
}

const names = (d: { files: { name?: string }[] }) => d.files.map((f) => f.name).sort()

describe('loadOwnDriveIndexed', () => {
  beforeAll(async () => {
    await Crypto.init()
  })

  it('first load reads everything and equals a full read', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay([...s.events, legacyFile('old1', 'old.txt')])
    const store = new MemoryDriveIndexStore()
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    const full = await loadOwnDrive(relay.query, OWNER, ROOT)
    expect(names(drive)).toEqual(names(full))
    expect(names(drive)).toEqual(['alpha.txt', 'old.txt', 'root.txt'])
    expect(drive.shape).toBe('sealed')
    expect(drive.fileKeys.get(s.a1.id)).toEqual(s.a1.key)
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
  })

  it('a later load asks only for newer events and decrypts nothing it already opened', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    relay.filters.length = 0
    const { opener, calls } = countingOpener()
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, opener, now: () => T0 + 200 })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
    expect(drive.fileKeys.get(s.r1.id)).toEqual(s.r1.key)
    expect(drive.folderKeys.get(s.A.id)).toEqual(s.A.key)
    expect(relay.filters.length).toBeGreaterThan(0)
    expect(relay.filters.every((f) => f.since === T0 + 100 - SYNC_SKEW_SECONDS)).toBe(true)
    expect(calls).toEqual({ ring: 0, folder: 0, file: 0 })
  })

  it('picks up a rename made on another device', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    relay.events.push(await s.r1Event('renamed.txt', T0 + 150))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(names(drive)).toEqual(['alpha.txt', 'renamed.txt'])
  })

  it('picks up an edit whose clock ran a little behind this device', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 1000 })
    // Published after the last sync, stamped 2 minutes before it.
    relay.events.push(await s.r1Event('late.txt', T0 + 880))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 1100 })
    expect(names(drive)).toEqual(['alpha.txt', 'late.txt'])
  })

  it('drops a sealed file tombstoned on another device', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    relay.events.push(await s.aRing([{ d: s.a1.d, deletedAt: T0 + 150 }], T0 + 150))
    relay.events.push(signed({ kind: 5, created_at: 0, tags: [['a', `30078:${OWNER}:${s.a1.d}`]], content: '' }, T0 + 150))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(names(drive)).toEqual(['root.txt'])
  })

  it('drops an old-shape file deleted (kind 5) on another device', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt'), legacyFile('old2', 'keep.txt')])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    relay.events.push(signed({ kind: 5, created_at: 0, tags: [['a', `30078:${OWNER}:old1`]], content: '' }, T0 + 150))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(names(drive)).toEqual(['keep.txt'])
  })

  it('reads everything again after a day, so anything the relay dropped goes too', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt'), legacyFile('old2', 'keep.txt')])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    relay.events.splice(0, 1)
    const soon = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(names(soon)).toEqual(['keep.txt', 'old.txt'])
    relay.filters.length = 0
    const later = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 + 86_400 })
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    expect(names(later)).toEqual(['keep.txt'])
  })

  it('stores the index encrypted: no name, no key, no event content in the clear', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay([...s.events, legacyFile('old1', 'plainname.txt')])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    const raw = (await store.get(OWNER))!
    const text = new TextDecoder('latin1').decode(raw)
    expect(text).not.toContain('plainname')
    expect(text).not.toContain('alpha.txt')
    expect(text).not.toContain(s.a1.d)
    expect(Crypto.bytesToHex(raw)).not.toContain(Crypto.bytesToHex(s.a1.key))
  })

  it('an index this root key cannot open is ignored and rebuilt by a full read', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await store.put(OWNER, new Uint8Array([1, 2, 3, 4, 5]))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    relay.filters.length = 0
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(relay.filters.every((f) => typeof f.since === 'number')).toBe(true)
  })

  it('without the root key it neither reads nor writes the index', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt')])
    const store = new MemoryDriveIndexStore()
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, null, { store, now: () => T0 + 100 })
    expect(names(drive)).toEqual(['old.txt'])
    expect(await store.get(OWNER)).toBeNull()
  })

  it('remembers a key opened through owner_key, so it costs one signer call once', async () => {
    const rootCK = await rootContainerKey(ROOT)
    const lost = { id: 'f9'.padEnd(32, '0'), key: k(9), d: randomD() }
    const relay = fakeRelay([
      signed(await sealRing({ folderKey: rootCK, folderId: '', files: [], folders: [], tombstones: [] })),
      signed({
        ...(await sealFileEvent({ d: lost.d, q: await folderQ(rootCK, ''), fileKey: lost.key, meta: fileMeta(lost.id, 'lost.txt', null) })),
        tags: [['d', lost.d], ['q', await folderQ(rootCK, '')], ['owner_key', 'envelope']],
      } as UnsignedEvent),
    ])
    let signerCalls = 0
    const unwrapOwner = async () => (signerCalls++, lost.key)
    const store = new MemoryDriveIndexStore()
    const first = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, unwrapOwner, now: () => T0 + 100 })
    const second = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, unwrapOwner, now: () => T0 + 200 })
    expect(names(first)).toEqual(['lost.txt'])
    expect(names(second)).toEqual(['lost.txt'])
    expect(signerCalls).toBe(1)
  })

  it('a store that fails never fails the listing', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt')])
    const store = new MemoryDriveIndexStore()
    store.get = async () => { throw new Error('quota') }
    store.put = async () => { throw new Error('quota') }
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    expect(names(drive)).toEqual(['old.txt'])
  })
})
