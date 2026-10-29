// The per-device drive index: decrypt once, keep it (encrypted) on the device,
// then fetch only what changed. It must give exactly the drive a full read
// gives, including deletes and edits made on other devices.
import { beforeAll, describe, it, expect } from 'vitest'
import { loadOwnDrive, type DriveOpener, type QueryFn } from './drive'
import { CONFIRM_SECONDS, forgetDriveIndex, loadOwnDriveIndexed, MemoryDriveIndexStore, SYNC_SKEW_SECONDS } from './driveIndex'
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
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'

const SK = new Uint8Array(32).fill(7)
const OWNER = getPublicKey(SK)
const ROOT = new Uint8Array(32).fill(1)
const k = (n: number) => new Uint8Array(32).fill(n)
const T0 = 1_760_000_000

function signed(ev: UnsignedEvent, createdAt = T0, sk = SK): SignedEvent {
  const { id, pubkey, sig, kind, created_at, tags, content } = finalizeEvent({ ...ev, created_at: createdAt }, sk)
  return { id, pubkey, sig, kind, created_at, tags, content }
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

/** A relay over `events`: honours kinds, authors, #d, since, until and limit, newest first. */
function fakeRelay(events: SignedEvent[]) {
  const filters: NostrFilter[] = []
  const query: QueryFn = async (fs) => {
    filters.push(...fs)
    const out: SignedEvent[] = []
    for (const raw of fs) {
      const f = raw as { kinds?: number[]; authors?: string[]; '#d'?: string[]; since?: number; until?: number; limit?: number }
      const hit = events
        .filter((e) => !f.kinds || f.kinds.includes(e.kind))
        .filter((e) => !f.authors || f.authors.includes(e.pubkey))
        .filter((e) => !f['#d'] || f['#d'].includes(e.tags.find((t) => t[0] === 'd')?.[1] ?? ''))
        .filter((e) => f.since === undefined || e.created_at >= f.since)
        .filter((e) => f.until === undefined || e.created_at <= f.until)
        .sort((a, b) => b.created_at - a.created_at)
      out.push(...hit.slice(0, f.limit ?? hit.length))
    }
    return out
  }
  return { query, filters, events }
}

const kindsOf = (f: NostrFilter) => (f as { kinds?: number[] }).kinds ?? []

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
async function sampleDrive(at = T0) {
  const rootCK = await rootContainerKey(ROOT)
  const A = { id: 'a1'.padEnd(32, '0'), key: k(2), d: randomD() }
  const r1 = { id: 'f1'.padEnd(32, '0'), key: k(4), d: randomD() }
  const a1 = { id: 'f2'.padEnd(32, '0'), key: k(5), d: randomD() }
  const rootRing = (files = [r1], createdAt = at) =>
    sealRing({ folderKey: rootCK, folderId: '', files, folders: [A], tombstones: [] }).then((e) => signed(e, createdAt))
  const aRing = async (tombstones: { d: string; deletedAt: number }[] = [], createdAt = at) =>
    signed(await sealRing({ folderKey: A.key, folderId: A.id, files: [a1], folders: [], tombstones }), createdAt)
  const r1Event = async (name: string, createdAt = at) =>
    signed(await sealFileEvent({ d: r1.d, q: await folderQ(rootCK, ''), fileKey: r1.key, meta: fileMeta(r1.id, name, null) }), createdAt)
  const events: SignedEvent[] = [
    await rootRing(),
    await aRing(),
    signed(await sealFolderEvent({ d: A.d, q: await folderQ(rootCK, ''), folderKey: A.key, meta: { id: A.id, name: 'Alpha', parentId: null } }), at),
    await r1Event('root.txt'),
    signed(await sealFileEvent({ d: a1.d, q: await folderQ(A.key, A.id), fileKey: a1.key, meta: fileMeta(a1.id, 'alpha.txt', A.id) }), at),
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

  it('once confirmed, a load asks only for newer file events and decrypts nothing it already opened', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    // The second load reads in full once more, to confirm the first.
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 150 })
    relay.filters.length = 0
    const { opener, calls } = countingOpener()
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, opener, now: () => T0 + 200 })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
    expect(drive.fileKeys.get(s.r1.id)).toEqual(s.r1.key)
    expect(drive.folderKeys.get(s.A.id)).toEqual(s.A.key)
    expect(relay.filters.length).toBeGreaterThan(0)
    // Files from the newest event seen (T0), less the skew; folders, rings and deletes in full.
    const fileFilters = relay.filters.filter((f) => kindsOf(f).includes(30078))
    expect(fileFilters.length).toBeGreaterThan(0)
    expect(fileFilters.every((f) => f.since === T0 - SYNC_SKEW_SECONDS && kindsOf(f).length === 1)).toBe(true)
    expect(relay.filters.filter((f) => !kindsOf(f).includes(30078)).every((f) => f.since === undefined)).toBe(true)
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
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 150 })
    relay.filters.length = 0
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(relay.filters.some((f) => typeof f.since === 'number')).toBe(true)
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

// Review of !225 (cloistr-audit): the indexed drive must equal a full read
// even when device clocks disagree or a full read comes back short.
describe('loadOwnDriveIndexed at the edges', () => {
  beforeAll(async () => {
    await Crypto.init()
  })

  it('this device clock 30 min fast: a rename made on a correct-clock device is still fetched', async () => {
    const s = await sampleDrive(T0)
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    const fast = 1800
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 + fast - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 + fast })
    relay.events.push(await s.r1Event('renamed.txt', T0 + 400))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 1000 + fast })
    const full = await loadOwnDrive(relay.query, OWNER, ROOT)
    expect(names(full)).toContain('renamed.txt')
    expect(names(drive)).toEqual(names(full))
  })

  it('another device clock 20 min slow: its delete (ring tombstone and kind 5) is still fetched', async () => {
    const s = await sampleDrive(T0 - 3600)
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    const late = T0 + 500 - 1200
    relay.events.push(await s.aRing([{ d: s.a1.d, deletedAt: late }], late))
    relay.events.push(signed({ kind: 5, created_at: 0, tags: [['a', `30078:${OWNER}:${s.a1.d}`]], content: '' }, late))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 1000 })
    const full = await loadOwnDrive(relay.query, OWNER, ROOT)
    expect(names(full)).not.toContain('alpha.txt')
    expect(names(drive)).toEqual(names(full))
  })

  it('deletes stamped days in the past are still fetched (folders, rings and kind 5 are always read in full)', async () => {
    const s = await sampleDrive(T0 - 10 * 86_400)
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    const past = T0 - 5 * 86_400
    relay.events.push(await s.aRing([{ d: s.a1.d, deletedAt: past }], past))
    relay.events.push(signed({ kind: 5, created_at: 0, tags: [['a', `30078:${OWNER}:${s.a1.d}`]], content: '' }, past))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 300 })
    expect(names(drive)).toEqual(['root.txt'])
  })

  it('a rename stamped 50 min before the newest event is still fetched', async () => {
    const s = await sampleDrive(T0 - 7200)
    const relay = fakeRelay([...s.events, legacyFile('new1', 'new.txt', T0 + 50)])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    // Signed on a slow device (or through a signer that waited on the user).
    relay.events.push(await s.r1Event('slow.txt', T0 + 50 - 3000))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 400 })
    expect(names(drive)).toEqual(['alpha.txt', 'new.txt', 'slow.txt'])
  })

  it('a device clock hours fast does not push the cursor past this device clock', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    // A device two hours fast writes a file.
    const legacyAhead = legacyFile('ahead', 'ahead.txt', T0 + 7200)
    relay.events.push(legacyAhead)
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    relay.events.push(await s.r1Event('renamed.txt', T0 + 300))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 400 })
    expect(names(drive)).toEqual(['ahead.txt', 'alpha.txt', 'renamed.txt'])
  })

  it('an empty full read is not kept: the next load reads in full again', async () => {
    const s = await sampleDrive(T0 - 3600)
    const relay = fakeRelay([])
    const store = new MemoryDriveIndexStore()
    const first = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 })
    expect(first.files.length).toBe(0)
    relay.events.push(...s.events)
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 300 })
    const full = await loadOwnDrive(relay.query, OWNER, ROOT)
    expect(names(full)).toEqual(['alpha.txt', 'root.txt'])
    expect(names(drive)).toEqual(names(full))
  })

  it('a short first full read is not the base: the second load reads in full and fills it in', async () => {
    const s = await sampleDrive(T0 - 3600)
    const relay = fakeRelay(s.events.slice(0, 2))
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 })
    relay.events.push(...s.events.slice(2))
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 300 })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
  })

  it('a full read that comes back short does not shrink the drive; a second one, an hour on, does', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt'), legacyFile('old2', 'keep.txt')])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    const saved = relay.events.splice(0)
    // The relay answers the daily full read with nothing (restarting).
    relay.filters.length = 0
    const blank = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 + 86_400 })
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    expect(names(blank)).toEqual(['keep.txt', 'old.txt'])
    // Back, but it lost old1 (no kind 5). Within the hour: still listed.
    relay.events.push(saved[1])
    const soon = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 300 + 86_400 })
    expect(names(soon)).toEqual(['keep.txt', 'old.txt'])
    relay.filters.length = 0
    const confirmed = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 + 86_400 + 3600 })
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    expect(names(confirmed)).toEqual(['keep.txt'])
  })

  it('an event with a bad signature, or by another author, is neither applied nor kept', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    const forged = signed({ kind: 5, created_at: 0, tags: [['a', `30078:${OWNER}:${s.a1.d}`]], content: '' }, T0 + 150)
    relay.events.push({ ...forged, sig: forged.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) })
    const stranger = signed({ kind: 5, created_at: 0, tags: [['a', `30078:${OWNER}:${s.a1.d}`]], content: '' }, T0 + 160, new Uint8Array(32).fill(9))
    relay.events.push(stranger)
    // A relay that ignores the authors filter.
    const leaky: QueryFn = async (fs) => relay.query(fs.map((f) => ({ ...f, authors: undefined })))
    const drive = await loadOwnDriveIndexed(leaky, OWNER, ROOT, { store, now: () => T0 + 200 })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
    const again = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 300 })
    expect(names(again)).toEqual(['alpha.txt', 'root.txt'])
  })

  it('forgetDriveIndex removes this account from the device', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    expect(await store.get(OWNER)).not.toBeNull()
    await forgetDriveIndex(OWNER, store)
    expect(await store.get(OWNER)).toBeNull()
  })

  it('when two full reads an hour apart both find nothing, the empty drive is kept and loads go incremental', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt')])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    relay.events.splice(0)
    expect(names(await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 + 86_400 }))).toEqual(['old.txt'])
    expect(names(await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 + 86_400 + 3600 }))).toEqual([])
    relay.filters.length = 0
    const next = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 300 + 86_400 + 3600 })
    expect(names(next)).toEqual([])
    expect(relay.filters.some((f) => typeof f.since === 'number' && f.since > T0)).toBe(true)
  })

  // Re-review of !225 (cloistr-audit): the ring lists the new file, but its
  // file event is stamped before the cursor, so the incremental read skips it.
  it('a new upload from a device clock 2 h slow shows on the next incremental load', async () => {
    // Folders last written days ago; a correct-clock device wrote a file just now (the cursor).
    const s = await sampleDrive(T0 - 3 * 86_400)
    const relay = fakeRelay([...s.events, legacyFile('now1', 'now.txt', T0)])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    const rootCK = await rootContainerKey(ROOT)
    const up = { id: 'f7'.padEnd(32, '0'), key: k(7), d: randomD() }
    const slow = T0 + 300 - 7200
    relay.events.push(
      signed(await sealRing({ folderKey: rootCK, folderId: '', files: [s.r1, up], folders: [s.A], tombstones: [] }), slow),
      signed(await sealFileEvent({ d: up.d, q: await folderQ(rootCK, ''), fileKey: up.key, meta: fileMeta(up.id, 'upload.txt', null) }), slow),
    )
    relay.filters.length = 0
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 400 })
    // Still an incremental load, plus one request for the listed file by its d.
    expect(relay.filters.some((f) => typeof f.since === 'number')).toBe(true)
    expect(names(drive)).toEqual(['alpha.txt', 'now.txt', 'root.txt', 'upload.txt'])
    expect(names(drive)).toEqual(names(await loadOwnDrive(relay.query, OWNER, ROOT)))
    // Kept: the next load needs no extra request for it.
    relay.filters.length = 0
    expect(names(await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 500 }))).toEqual(['alpha.txt', 'now.txt', 'root.txt', 'upload.txt'])
    expect(relay.filters.some((f) => '#d' in f)).toBe(false)
  })

  it('a file moved into a folder from a slow device, whose record this device never had, shows in that folder', async () => {
    const s = await sampleDrive(T0 - 3 * 86_400)
    // The file was written on another device and then moved, both on its slow clock; this device never stored it.
    const relay = fakeRelay([...s.events, legacyFile('now1', 'now.txt', T0)])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    const mv = { id: 'f8'.padEnd(32, '0'), key: k(8), d: randomD() }
    const slow = T0 + 300 - 7200
    relay.events.push(
      signed(await sealRing({ folderKey: s.A.key, folderId: s.A.id, files: [s.a1, mv], folders: [], tombstones: [] }), slow),
      signed(await sealFileEvent({ d: mv.d, q: await folderQ(s.A.key, s.A.id), fileKey: mv.key, meta: fileMeta(mv.id, 'moved.txt', s.A.id) }), slow),
    )
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 400 })
    expect(drive.files.find((f) => f.name === 'moved.txt')?.folder_id).toBe(s.A.id)
    expect(names(drive)).toEqual(names(await loadOwnDrive(relay.query, OWNER, ROOT)))
  })

  it('a ring entry whose file is gone from the relay costs one request and does not break the listing', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 - CONFIRM_SECONDS })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 200 })
    const rootCK = await rootContainerKey(ROOT)
    const ghost = { id: 'f6'.padEnd(32, '0'), key: k(6), d: randomD() }
    relay.events.push(signed(await sealRing({ folderKey: rootCK, folderId: '', files: [s.r1, ghost], folders: [s.A], tombstones: [] }), T0 + 300))
    relay.filters.length = 0
    const drive = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 400 })
    expect(names(drive)).toEqual(['alpha.txt', 'root.txt'])
    expect(relay.filters.filter((f) => '#d' in f)).toEqual([expect.objectContaining({ '#d': [ghost.d] })])
  })

  // Live proof of !225: one page load lists the drive several times, so a
  // second full read seconds after the first must not confirm it.
  it('two short full reads seconds apart do not become the base: the next load reads in full and heals', async () => {
    const s = await sampleDrive(T0 - 3 * 86_400)
    const recent = legacyFile('now1', 'now.txt', T0)
    // The relay answers short: rings and one recent file, no folder or file events.
    const relay = fakeRelay([...s.events.slice(0, 2), recent])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 105 })
    relay.events.push(...s.events.slice(2))
    relay.filters.length = 0
    const healed = await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 110 })
    expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    expect(names(healed)).toEqual(['alpha.txt', 'now.txt', 'root.txt'])
  })

  it('a full read an hour after the first confirms the index; loads then go incremental', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    for (const t of [T0 + 200, T0 + 1000, T0 + 3000]) {
      relay.filters.length = 0
      await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => t })
      expect(relay.filters.every((f) => f.since === undefined)).toBe(true)
    }
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 + 3600 })
    relay.filters.length = 0
    expect(names(await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 3800 }))).toEqual(['alpha.txt', 'root.txt'])
    expect(relay.filters.some((f) => typeof f.since === 'number')).toBe(true)
  })

  it('before confirmation, full reads seconds apart that lack an event do not drop it', async () => {
    const relay = fakeRelay([legacyFile('old1', 'old.txt'), legacyFile('old2', 'keep.txt')])
    const store = new MemoryDriveIndexStore()
    await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => T0 + 100 })
    // The relay loses old1 (no kind 5) for a few seconds.
    relay.events.splice(0, 1)
    for (const t of [T0 + 105, T0 + 110, T0 + 115]) {
      expect(names(await loadOwnDriveIndexed(relay.query, OWNER, ROOT, { store, now: () => t }))).toEqual(['keep.txt', 'old.txt'])
    }
  })

  it('a load still running when the index is forgotten does not write it back', async () => {
    const s = await sampleDrive()
    const relay = fakeRelay(s.events)
    const store = new MemoryDriveIndexStore()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow: QueryFn = async (fs) => (await gate, relay.query(fs))
    const loading = loadOwnDriveIndexed(slow, OWNER, ROOT, { store, now: () => T0 + 100 })
    await forgetDriveIndex(OWNER, store)
    release()
    expect(names(await loading)).toEqual(['alpha.txt', 'root.txt'])
    expect(await store.get(OWNER)).toBeNull()
  })
})
