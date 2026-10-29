// Drive interop Phase 1, step 4: writing a sealed drive. Every case writes
// through driveWrite.ts into an in-memory relay and reads the result back
// with the real reader (buildOwnDrive / listSharedFolder).
import { describe, it, expect } from 'vitest'
import { buildOwnDrive, listSharedFolder, type QueryFn } from './drive'
import {
  addFile,
  createFolder,
  deleteFile,
  deleteFolder,
  isSealedDrive,
  updateFile,
  updateFolder,
  withNewVersion,
  type WriteContext,
} from './driveWrite'
import { rootContainerKey, ringD, type SealedFileMeta } from './sealed'
import type { SignedEvent } from './api'
import type { UnsignedEvent } from './relay'

const OWNER = 'a'.repeat(64)
const ROOT = new Uint8Array(32).fill(1)
const k = (n: number) => new Uint8Array(32).fill(n)

// A relay that keeps the newest event per kind:d (NIP-01 addressable) and
// answers kinds/authors/#d/#q filters.
function fakeRelay() {
  let seq = 0
  const events: SignedEvent[] = []
  const published: SignedEvent[] = []
  type F = { kinds?: number[]; authors?: string[]; '#d'?: string[]; '#q'?: string[] }
  const matches = (ev: SignedEvent, f: F) =>
    (!f.kinds || f.kinds.includes(ev.kind)) &&
    (!f.authors || f.authors.includes(ev.pubkey)) &&
    (!f['#d'] || f['#d'].includes(ev.tags.find((t) => t[0] === 'd')?.[1] ?? '')) &&
    (!f['#q'] || f['#q'].includes(ev.tags.find((t) => t[0] === 'q')?.[1] ?? ''))
  const store = (ev: SignedEvent) => {
    const d = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (ev.kind >= 30000 && ev.kind < 40000 && d !== undefined) {
      const i = events.findIndex((e) => e.kind === ev.kind && e.pubkey === ev.pubkey && e.tags.find((t) => t[0] === 'd')?.[1] === d)
      if (i >= 0) {
        if (events[i].created_at > ev.created_at) return
        events.splice(i, 1)
      }
    }
    events.push(ev)
  }
  const sign = (ev: UnsignedEvent, pubkey = OWNER): SignedEvent => ({
    ...ev,
    pubkey,
    id: (++seq).toString(16).padStart(64, '0'),
    sig: '',
  })
  const query: QueryFn = async (filters) => events.filter((ev) => filters.some((f) => matches(ev, f as F)))
  return {
    events,
    published,
    sign,
    store,
    query,
    /** Runs after each publish; a test uses it to play another device. */
    afterPublish: null as null | ((ev: SignedEvent) => Promise<void>),
    failRingPublish: false,
  }
}

type Relay = ReturnType<typeof fakeRelay>

// Owner envelope stand-in: the real one is NIP-44 to self. Bound to the subject.
const wrapForOwner = async (key: Uint8Array, subject: string) =>
  btoa(JSON.stringify({ s: subject, k: Array.from(key) }))
const unwrapOwner = async (env: string, subject: string) => {
  const o = JSON.parse(atob(env)) as { s: string; k: number[] }
  if (o.s !== subject) throw new Error('envelope bound to another subject')
  return new Uint8Array(o.k)
}

function ctxFor(relay: Relay): WriteContext {
  return {
    pubkey: OWNER,
    query: relay.query,
    publish: async (ev) => {
      if (relay.failRingPublish && ev.kind === 30079 && ev.tags.length === 1) throw new Error('relay rejected')
      const s = relay.sign(ev)
      relay.store(s)
      relay.published.push(s)
      if (relay.afterPublish) await relay.afterPublish(s)
      return s
    },
    wrapForOwner,
    rootKey: ROOT,
    folderKeys: new Map(),
  }
}

const meta = (id: string, name: string, folderId: string | null = null): SealedFileMeta => ({
  id,
  name,
  folderId,
  sha256: 'e'.repeat(64),
  size: 10,
  encryptedSize: 50,
  mimeType: 'text/plain',
  plaintextHash: 'f'.repeat(64),
})
const id = (n: number) => n.toString(16).padStart(32, '0')

describe('sealed writes', () => {
  it('a new file and a new folder read back through the reader, with a random folder key', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    expect(await isSealedDrive(ctx, ROOT)).toBe(false)
    const A = await createFolder(ctx, { id: id(1), name: 'Alpha', parentId: null })
    const A2 = await createFolder(ctx, { id: id(2), name: 'Alpha again', parentId: null })
    expect(A.key).not.toEqual(A2.key) // random, not derived
    expect(A.key).toHaveLength(32)
    await addFile(ctx, { key: k(4), meta: meta(id(10), 'root.txt') })
    await addFile(ctx, { key: k(5), meta: meta(id(11), 'in-alpha.txt', A.id) })
    expect(await isSealedDrive(ctx, ROOT)).toBe(true)

    const drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.unreadable).toEqual([])
    expect(drive.files.map((f) => [f.name, f.folder_id]).sort()).toEqual([
      ['in-alpha.txt', A.id],
      ['root.txt', ''],
    ])
    expect(drive.folders.map((f) => f.name).sort()).toEqual(['Alpha', 'Alpha again'])
    expect(drive.fileKeys.get(id(11))).toEqual(k(5))
    expect(drive.folderKeys.get(A.id)).toBeDefined()
  })

  it('puts nothing about the file or folder in the clear', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const A = await createFolder(ctx, { id: id(1), name: 'SecretFolder', parentId: null })
    const ref = await addFile(ctx, { key: k(4), meta: { ...meta(id(10), 'secret-name.pdf', A.id), userTags: ['taxes'] } })
    await updateFile(ctx, ref, (m) => ({ ...m, name: 'renamed-secret.pdf' }))
    for (const ev of relay.events) {
      const clear = JSON.stringify(ev.tags) + ev.content
      for (const leak of ['SecretFolder', 'secret', 'taxes', id(1), id(10), 'e'.repeat(64), 'f'.repeat(64), 'text/plain']) {
        expect(clear).not.toContain(leak)
      }
      expect(ev.tags.map((t) => t[0]).every((n) => ['d', 'q', 'owner_key'].includes(n))).toBe(true)
    }
  })

  it('rename, trash, restore, tags and a new version change the current event, each strictly newer', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const ref = await addFile(ctx, { key: k(4), meta: meta(id(10), 'a.txt') })
    const times: number[] = []
    const step = async (change: (m: SealedFileMeta) => SealedFileMeta) => {
      await updateFile(ctx, ref, change)
      times.push(relay.published.filter((e) => e.kind === 30078).at(-1)!.created_at)
    }
    await step((m) => ({ ...m, name: 'b.txt' }))
    await step((m) => ({ ...m, deletedAt: 123 }))
    let drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.files[0].deleted_at).toBe(123)
    await step((m) => ({ ...m, deletedAt: undefined }))
    await step((m) => ({ ...m, userTags: ['x', 'y'] }))
    await step((m) => withNewVersion(m, { sha256: 'c'.repeat(64), size: 11, encryptedSize: 51 }, 500))
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])

    drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    const f = drive.files[0]
    expect([f.name, f.deleted_at, f.tags, f.sha256, f.size]).toEqual(['b.txt', undefined, ['x', 'y'], 'c'.repeat(64), 11])
    expect((f.versions as { sha256: string }[]).map((v) => v.sha256)).toEqual(['e'.repeat(64), 'c'.repeat(64)])
    // The owner fallback survives every edit.
    expect(f.owner_key).toBe(await wrapForOwner(k(4), ref.d))
  })

  it('a move republishes under the new q and moves the ring entry; recipients see it only in the new folder', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const A = await createFolder(ctx, { id: id(1), name: 'A', parentId: null })
    const B = await createFolder(ctx, { id: id(2), name: 'B', parentId: null })
    const ref = await addFile(ctx, { key: k(4), meta: meta(id(10), 'moving.txt', A.id) })
    await updateFile(ctx, ref, (m) => ({ ...m, folderId: B.id }))

    const drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.files.map((f) => [f.name, f.folder_id])).toEqual([['moving.txt', B.id]])
    expect((await listSharedFolder(relay.query, OWNER, A.id, A.key)).files).toEqual([])
    expect((await listSharedFolder(relay.query, OWNER, B.id, B.key)).files.map((f) => f.name)).toEqual(['moving.txt'])
  })

  it('a permanent delete is a kind 5 plus a ring tombstone; nothing is left unreadable', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const keep = await addFile(ctx, { key: k(4), meta: meta(id(10), 'keep.txt') })
    const gone = await addFile(ctx, { key: k(5), meta: meta(id(11), 'gone.txt') })
    await deleteFile(ctx, gone, null)
    const del = relay.events.find((e) => e.kind === 5)!
    expect(del.tags).toEqual([['a', `30078:${OWNER}:${gone.d}`]])
    const drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.files.map((f) => f.name)).toEqual(['keep.txt'])
    expect(drive.unreadable).toEqual([])
    expect(keep.d).not.toBe(gone.d)
  })

  it('deleting a folder removes its whole subtree, and renaming one keeps its place', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const A = await createFolder(ctx, { id: id(1), name: 'A', parentId: null })
    const B = await createFolder(ctx, { id: id(2), name: 'B', parentId: A.id })
    const a1 = await addFile(ctx, { key: k(4), meta: meta(id(10), 'a1.txt', A.id) })
    const b1 = await addFile(ctx, { key: k(5), meta: meta(id(11), 'b1.txt', B.id) })
    await addFile(ctx, { key: k(6), meta: meta(id(12), 'root.txt') })
    await updateFolder(ctx, B, (m) => ({ ...m, name: 'B renamed' }))
    let drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.folders.find((f) => f.id === B.id)).toMatchObject({ name: 'B renamed', parent_id: A.id })

    await deleteFolder(ctx, A, null, { folders: [B], files: [a1, b1] })
    drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.files.map((f) => f.name)).toEqual(['root.txt'])
    expect(drive.folders).toEqual([])
    expect(drive.unreadable).toEqual([])
    const named = relay.events.find((e) => e.kind === 5)!.tags.map((t) => t[1])
    expect(named).toEqual(
      expect.arrayContaining([
        `30079:${OWNER}:${A.d}`,
        `30079:${OWNER}:${await ringD(A.key, A.id)}`,
        `30079:${OWNER}:${B.d}`,
        `30078:${OWNER}:${a1.d}`,
        `30078:${OWNER}:${b1.d}`,
      ]),
    )
  })

  it('merges onto a ring another device published in between, keeping both entries', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    // Device 2 has written one file already.
    const other = ctxFor(relay)
    await addFile(other, { key: k(9), meta: meta(id(20), 'from-device-2.txt') })
    // Device 2 rewrites the root ring right after device 1's ring write, without device 1's entry.
    const rootRingD = await ringD(await rootContainerKey(ROOT), '')
    const snapshot = relay.events.find((e) => e.tags[0][1] === rootRingD)!
    let raced = false
    relay.afterPublish = async (ev) => {
      if (raced || ev.tags[0][1] !== rootRingD) return
      raced = true
      relay.store(relay.sign({ ...snapshot, created_at: ev.created_at + 1 }))
    }
    await addFile(ctx, { key: k(4), meta: meta(id(10), 'from-device-1.txt') })
    expect(raced).toBe(true)
    const drive = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(drive.files.map((f) => f.name).sort()).toEqual(['from-device-1.txt', 'from-device-2.txt'])
  })

  it('a file whose ring entry was lost still reaches its owner through owner_key', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    await addFile(ctx, { key: k(4), meta: meta(id(10), 'listed.txt') })
    relay.failRingPublish = true
    await expect(addFile(ctx, { key: k(5), meta: meta(id(11), 'orphan.txt') })).rejects.toThrow('relay rejected')

    const without = await buildOwnDrive(relay.events, OWNER, ROOT)
    expect(without.files.map((f) => f.name)).toEqual(['listed.txt'])
    expect(without.unreadable).toHaveLength(1)

    const withFallback = await buildOwnDrive(relay.events, OWNER, ROOT, { unwrapOwner })
    expect(withFallback.files.map((f) => f.name).sort()).toEqual(['listed.txt', 'orphan.txt'])
    expect(withFallback.fileKeys.get(id(11))).toEqual(k(5))
    expect(withFallback.unreadable).toEqual([])

    // Without the root key nothing is unwrapped one by one (the signer is likely down too).
    let calls = 0
    const noRoot = await buildOwnDrive(relay.events, OWNER, null, { unwrapOwner: async (e, d) => (calls++, unwrapOwner(e, d)) })
    expect(calls).toBe(0)
    expect(noRoot.shape).toBe('unknown')
    expect(withFallback.shape).toBe('sealed')
  })

  it('a deleted file stays deleted when the relay keeps its event despite the kind 5', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const gone = await addFile(ctx, { key: k(5), meta: meta(id(11), 'gone.txt') })
    await deleteFile(ctx, gone, null)
    const kept = relay.events.filter((e) => e.kind !== 5) // the relay ignored the deletion
    const drive = await buildOwnDrive(kept, OWNER, ROOT, { unwrapOwner })
    expect(drive.files).toEqual([])
  })

  it('sealed events without a root ring make the shape unknown, never legacy', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    await addFile(ctx, { key: k(4), meta: meta(id(10), 'a.txt') })
    const rootRingD = await ringD(await rootContainerKey(ROOT), '')
    const withheld = relay.events.filter((e) => e.tags[0][1] !== rootRingD)
    expect((await buildOwnDrive(withheld, OWNER, ROOT)).shape).toBe('unknown')
    expect((await buildOwnDrive([], OWNER, ROOT)).shape).toBe('legacy')
    // An old-shape drive: its root-key event and other apps' events are not sealed items.
    const rootKeyEvent = relay.sign({ kind: 30078, created_at: 1, tags: [['d', 'root-key'], ['key', 'x']], content: '' })
    const otherApp = relay.sign({ kind: 30078, created_at: 1, tags: [['d', 'app-setting']], content: 'AQIDBAUG' })
    expect((await buildOwnDrive([rootKeyEvent, otherApp], OWNER, ROOT)).shape).toBe('legacy')
  })

  it('an edit wraps the owner envelope afresh instead of keeping the relay copy', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    const ref = await addFile(ctx, { key: k(4), meta: meta(id(10), 'a.txt') })
    const ev = relay.events.find((e) => e.tags[0][1] === ref.d)!
    ev.tags = ev.tags.map((t) => (t[0] === 'owner_key' ? ['owner_key', 'broken'] : t))
    await updateFile(ctx, ref, (m) => ({ ...m, name: 'b.txt' }))
    const after = relay.events.find((e) => e.tags[0][1] === ref.d)!
    expect(after.tags.find((t) => t[0] === 'owner_key')![1]).toBe(await wrapForOwner(k(4), ref.d))
  })

  it('refuses to edit a file the relay has no record of, and publishes nothing', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    await expect(updateFile(ctx, { d: 'nope', id: id(1), key: k(1) }, (m) => m)).rejects.toThrow('no record')
    expect(relay.published).toEqual([])
  })

  it('refuses to write into a folder whose key it does not hold', async () => {
    const relay = fakeRelay()
    const ctx = ctxFor(relay)
    await expect(addFile(ctx, { key: k(4), meta: meta(id(10), 'x', id(99)) })).rejects.toThrow('no key for folder')
    expect(relay.published).toEqual([])
  })
})
