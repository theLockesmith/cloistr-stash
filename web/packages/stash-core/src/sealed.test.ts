// Drive interop Phase 1 (S1 to S5): the sealed event shape. Spec:
// arbiter/conscience/specs/cloistr-drive-interop/, plan:
// specs/drive-interop-phase1/plan.md.
import { describe, it, expect } from 'vitest'
import {
  folderQ,
  ringD,
  randomD,
  rootContainerKey,
  isSealedEvent,
  sealFileEvent,
  openFileEvent,
  sealFolderEvent,
  openFolderEvent,
  sealRing,
  openRing,
  type SealedFileMeta,
} from './sealed'

const key = (fill: number) => new Uint8Array(32).fill(fill)
const ROOT = key(1)
const FOLDER = key(2)
const FILE = key(3)
const OTHER = key(9)

const meta: SealedFileMeta = {
  id: 'f'.repeat(32),
  name: 'tax-return-2025.pdf',
  folderId: 'a'.repeat(32),
  sha256: 'b'.repeat(64),
  size: 123_456,
  encryptedSize: 123_500,
  mimeType: 'application/pdf',
  plaintextHash: 'c'.repeat(64),
  userTags: ['finance', 'private'],
  versions: [{ sha256: 'b'.repeat(64), version: 2, createdAt: 1_760_000_000 }],
}

describe('q and ring d', () => {
  it('q is 32 hex, stable for a key and folder, and differs by key and by folder', async () => {
    const q = await folderQ(FOLDER, meta.folderId!)
    expect(q).toMatch(/^[0-9a-f]{32}$/)
    expect(await folderQ(FOLDER, meta.folderId!)).toBe(q)
    expect(await folderQ(OTHER, meta.folderId!)).not.toBe(q)
    expect(await folderQ(FOLDER, 'e'.repeat(32))).not.toBe(q)
    expect(q).not.toContain(meta.folderId!.slice(0, 8))
  })

  it('ring d differs from q for the same folder, and random d is 32 random hex', async () => {
    expect(await ringD(FOLDER, meta.folderId!)).not.toBe(await folderQ(FOLDER, meta.folderId!))
    const a = randomD()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(randomD()).not.toBe(a)
  })
})

describe('root container key', () => {
  it('is derived from the root key, 32 bytes, and is not the root key itself', async () => {
    const k = await rootContainerKey(ROOT)
    expect(k).toHaveLength(32)
    expect(Array.from(k)).not.toEqual(Array.from(ROOT))
    expect(Array.from(await rootContainerKey(ROOT))).toEqual(Array.from(k))
  })
})

describe('file event', () => {
  it('round-trips under the file key and keeps only d, q and owner_key in the clear', async () => {
    const d = randomD()
    const q = await folderQ(FOLDER, meta.folderId!)
    const ev = await sealFileEvent({ d, q, fileKey: FILE, meta, ownerEnvelope: 'nip44-envelope' })
    expect(ev.kind).toBe(30078)
    expect(ev.tags.map((t) => t[0]).sort()).toEqual(['d', 'owner_key', 'q'])
    expect(isSealedEvent(ev)).toBe(true)
    expect(await openFileEvent(ev, FILE)).toEqual(meta)
  })

  it('refuses the wrong key', async () => {
    const ev = await sealFileEvent({ d: randomD(), q: 'q', fileKey: FILE, meta })
    await expect(openFileEvent(ev, OTHER)).rejects.toThrow()
  })

  it('refuses content moved onto another event (d is bound inside the seal)', async () => {
    const ev = await sealFileEvent({ d: randomD(), q: 'q', fileKey: FILE, meta })
    const moved = { ...ev, tags: ev.tags.map((t) => (t[0] === 'd' ? ['d', randomD()] : t)) }
    await expect(openFileEvent(moved, FILE)).rejects.toThrow(/d/)
  })

  it('a root file has no folder id inside and still seals', async () => {
    const root = { ...meta, folderId: null }
    const ev = await sealFileEvent({ d: randomD(), q: await folderQ(ROOT, ''), fileKey: FILE, meta: root })
    expect(await openFileEvent(ev, FILE)).toEqual(root)
  })
})

describe('nonce', () => {
  it('every seal uses a fresh random nonce (same key, d and content seal differently)', async () => {
    const meta = { id: 'f'.repeat(32), name: 'same.txt', folderId: null, sha256: 'e'.repeat(64) }
    const key = new Uint8Array(32).fill(4)
    const seals = await Promise.all(Array.from({ length: 4 }, () => sealFileEvent({ d: 'dd', q: 'qq', fileKey: key, meta })))
    const nonces = seals.map((ev) => Buffer.from(ev.content, 'base64').subarray(1, 25).toString('hex'))
    expect(new Set(nonces).size).toBe(4)
    expect(new Set(seals.map((ev) => ev.content)).size).toBe(4)
    expect(nonces.every((n) => n !== '00'.repeat(24))).toBe(true)
  })
})

describe('folder event', () => {
  // conscience 2026-10-16: sealed under the folder's OWN key, so someone given
  // only that folder can read its name; the parent's ring holds the key.
  it('round-trips under its own key, not the parent key, with only d and q in the clear', async () => {
    const fm = { id: meta.folderId!, name: 'Taxes', description: 'IRS letters', parentId: null }
    const ev = await sealFolderEvent({ d: randomD(), q: await folderQ(ROOT, ''), folderKey: FOLDER, meta: fm })
    expect(ev.kind).toBe(30079)
    expect(ev.tags.map((t) => t[0]).sort()).toEqual(['d', 'q'])
    expect(await openFolderEvent(ev, FOLDER)).toEqual(fm)
    await expect(openFolderEvent(ev, ROOT)).rejects.toThrow()
  })
})

describe('key ring', () => {
  it('carries exactly one tag, the opaque d, and round-trips file, child folder and tombstone entries', async () => {
    const files = [{ d: randomD(), id: meta.id, key: FILE }]
    const folders = [{ d: randomD(), id: 'e'.repeat(32), key: OTHER }]
    const tombstones = [{ d: randomD(), deletedAt: 1_760_000_100 }]
    const ev = await sealRing({ folderKey: FOLDER, folderId: meta.folderId!, files, folders, tombstones })
    expect(ev.kind).toBe(30079)
    expect(ev.tags).toEqual([['d', await ringD(FOLDER, meta.folderId!)]])
    const ring = await openRing(ev, FOLDER, meta.folderId!)
    expect(ring.files).toEqual(files)
    expect(ring.folders).toEqual(folders)
    expect(ring.tombstones).toEqual(tombstones)
    await expect(openRing(ev, OTHER, meta.folderId!)).rejects.toThrow()
  })
})

// S1 to S3, S5: an observer holding every event and no keys learns no tree,
// type, size, tag, name or plaintext hash.
describe('outsider holding every event, no keys', () => {
  it('finds none of the private values anywhere in the events', async () => {
    const fm = { id: meta.folderId!, name: 'Taxes', description: 'IRS letters', parentId: null }
    const fileD = randomD()
    const events = [
      await sealFolderEvent({ d: randomD(), q: await folderQ(ROOT, ''), folderKey: FOLDER, meta: fm }),
      await sealFileEvent({ d: fileD, q: await folderQ(FOLDER, fm.id), fileKey: FILE, meta, ownerEnvelope: 'env' }),
      await sealRing({ folderKey: ROOT, folderId: '', files: [], folders: [{ d: randomD(), id: fm.id, key: FOLDER }], tombstones: [] }),
      await sealRing({ folderKey: FOLDER, folderId: fm.id, files: [{ d: fileD, id: meta.id, key: FILE }], folders: [], tombstones: [] }),
    ]
    const wire = JSON.stringify(events)
    for (const secret of [
      meta.id,
      meta.name,
      meta.folderId!,
      meta.sha256,
      meta.plaintextHash!,
      meta.mimeType!,
      String(meta.size),
      String(meta.encryptedSize),
      ...meta.userTags!,
      fm.name,
      fm.description,
    ]) {
      expect(wire, secret).not.toContain(secret)
    }
    for (const ev of events) {
      for (const t of ev.tags) expect(['d', 'q', 'owner_key']).toContain(t[0])
    }
  })

  it('old-shape events are not mistaken for sealed ones', () => {
    expect(isSealedEvent({ kind: 30078, created_at: 0, tags: [['d', 'x']], content: '{"name":"a"}' })).toBe(false)
  })
})
