// Drive interop Phase 1, step 2: reading a drive from the relay. The owner
// lists with ONE filter (author + kinds) and builds the tree locally, so the
// relay never learns parent-to-child edges (conscience 2026-10-16). A
// recipient lists one shared folder by #q.
import { describe, it, expect } from 'vitest'
import { buildOwnDrive, loadOwnDrive, listSharedFolder, type QueryFn } from './drive'
import {
  folderQ,
  randomD,
  ringD,
  rootContainerKey,
  sealFileEvent,
  sealFolderEvent,
  sealRing,
  type SealedFileMeta,
} from './sealed'
import type { SignedEvent } from './api'
import type { UnsignedEvent } from './relay'

const OWNER = 'a'.repeat(64)
const ROOT = new Uint8Array(32).fill(1)
const k = (n: number) => new Uint8Array(32).fill(n)

let seq = 0
function signed(ev: UnsignedEvent, createdAt = 1_760_000_000): SignedEvent {
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

// Root: file r1 and folder A. A: file a1 and folder B. B: file b1.
async function sampleDrive() {
  const rootCK = await rootContainerKey(ROOT)
  const A = { id: 'a1'.padEnd(32, '0'), key: k(2), d: randomD() }
  const B = { id: 'b1'.padEnd(32, '0'), key: k(3), d: randomD() }
  const r1 = { id: 'f1'.padEnd(32, '0'), key: k(4), d: randomD() }
  const a1 = { id: 'f2'.padEnd(32, '0'), key: k(5), d: randomD() }
  const b1 = { id: 'f3'.padEnd(32, '0'), key: k(6), d: randomD() }
  const gone = { id: 'f4'.padEnd(32, '0'), key: k(7), d: randomD() }
  const events: SignedEvent[] = [
    signed(await sealRing({ folderKey: rootCK, folderId: '', files: [r1], folders: [A], tombstones: [] })),
    signed(await sealRing({ folderKey: A.key, folderId: A.id, files: [a1, gone], folders: [B], tombstones: [{ d: gone.d, deletedAt: 1 }] })),
    signed(await sealRing({ folderKey: B.key, folderId: B.id, files: [b1], folders: [], tombstones: [] })),
    signed(await sealFolderEvent({ d: A.d, q: await folderQ(rootCK, ''), folderKey: A.key, meta: { id: A.id, name: 'Alpha', parentId: null } })),
    signed(await sealFolderEvent({ d: B.d, q: await folderQ(A.key, A.id), folderKey: B.key, meta: { id: B.id, name: 'Beta', parentId: A.id } })),
    signed(await sealFileEvent({ d: r1.d, q: await folderQ(rootCK, ''), fileKey: r1.key, meta: fileMeta(r1.id, 'root.txt', null) })),
    signed(await sealFileEvent({ d: a1.d, q: await folderQ(A.key, A.id), fileKey: a1.key, meta: fileMeta(a1.id, 'alpha.txt', A.id) })),
    signed(await sealFileEvent({ d: b1.d, q: await folderQ(B.key, B.id), fileKey: b1.key, meta: fileMeta(b1.id, 'beta.txt', B.id) })),
    signed(await sealFileEvent({ d: gone.d, q: await folderQ(A.key, A.id), fileKey: gone.key, meta: fileMeta(gone.id, 'gone.txt', A.id) })),
  ]
  return { events, rootCK, A, B, r1, a1, b1, gone }
}

const legacyFile = (d: string, name: string, folder?: string): SignedEvent =>
  signed({
    kind: 30078,
    created_at: 0,
    tags: [['d', d], ['x', 'e'.repeat(64)], ['m', 'image/png'], ['size', '42'], ['encrypted', 'xchacha20-poly1305'], ...(folder ? [['folder', folder]] : [])],
    content: JSON.stringify({ name, size: 42, encrypted_size: 58, mime_type: 'image/png', encrypted: true }),
  })

describe('buildOwnDrive', () => {
  it('rebuilds the whole tree from the root ring, with keys, and drops tombstoned files', async () => {
    const s = await sampleDrive()
    const drive = await buildOwnDrive(s.events, OWNER, ROOT)
    const byName = Object.fromEntries(drive.files.map((f) => [f.name, f]))
    expect(Object.keys(byName).sort()).toEqual(['alpha.txt', 'beta.txt', 'root.txt'])
    expect(byName['root.txt'].folder_id).toBe('')
    expect(byName['alpha.txt'].folder_id).toBe(s.A.id)
    expect(byName['beta.txt'].folder_id).toBe(s.B.id)
    expect(byName['beta.txt'].sealed).toBe(true)
    expect(drive.folders.map((f) => [f.name, f.parent_id ?? ''])).toEqual(
      expect.arrayContaining([['Alpha', ''], ['Beta', s.A.id]]),
    )
    expect(drive.fileKeys.get(s.b1.id)).toEqual(s.b1.key)
    expect(drive.folderKeys.get(s.B.id)).toEqual(s.B.key)
    expect(drive.unreadable).toEqual([])
  })

  it('reads old-shape files and folders alongside, newest replaceable version wins, kind 5 hides', async () => {
    const s = await sampleDrive()
    const oldFolder = signed({ kind: 30079, created_at: 0, tags: [['d', 'oldfolder']], content: JSON.stringify({ name: 'Old' }) })
    const deletedFolder = signed({ kind: 30079, created_at: 0, tags: [['d', 'deadfolder']], content: JSON.stringify({ name: 'Dead' }) })
    const del = signed({ kind: 5, created_at: 0, tags: [['a', `30079:${OWNER}:deadfolder`]], content: '' })
    const v1 = legacyFile('legacy1', 'old-name.png', 'oldfolder')
    const v2 = signed({ ...legacyFile('legacy1', 'new-name.png', 'oldfolder') }, 1_760_000_500)
    const rootKeyEvent = signed({ kind: 30078, created_at: 0, tags: [['d', 'root-key']], content: 'nip44...' })
    const prefs = signed({ kind: 30078, created_at: 0, tags: [['d', 'cloistr-relays']], content: '{"relays":[]}' })
    const drive = await buildOwnDrive([...s.events, oldFolder, deletedFolder, del, v1, v2, rootKeyEvent, prefs], OWNER, ROOT)
    const legacy = drive.files.filter((f) => !f.sealed)
    expect(legacy.map((f) => [f.name, f.folder_id, f.mime_type, f.size])).toEqual([['new-name.png', 'oldfolder', 'image/png', 42]])
    expect(drive.folders.map((f) => f.name).sort()).toEqual(['Alpha', 'Beta', 'Old'])
  })

  it('reports a sealed file no ring reaches as unreadable instead of dropping it silently', async () => {
    const s = await sampleDrive()
    const stray = signed(await sealFileEvent({ d: randomD(), q: 'x', fileKey: k(9), meta: fileMeta('f9'.padEnd(32, '0'), 'stray', null) }))
    const drive = await buildOwnDrive([...s.events, stray], OWNER, ROOT)
    expect(drive.unreadable).toEqual([{ kind: 30078, d: stray.tags[0][1], reason: 'not in any key ring' }])
  })

  it('places a file by its own content when a stale ring entry still lists it elsewhere', async () => {
    const s = await sampleDrive()
    // a1 moved to B: its content names B, but A's ring still lists it (stale).
    const moved = signed(
      await sealFileEvent({ d: s.a1.d, q: await folderQ(s.B.key, s.B.id), fileKey: s.a1.key, meta: fileMeta(s.a1.id, 'alpha.txt', s.B.id) }),
      1_760_000_900,
    )
    const drive = await buildOwnDrive([...s.events, moved], OWNER, ROOT)
    expect(drive.files.find((f) => f.name === 'alpha.txt')!.folder_id).toBe(s.B.id)
  })

  it('without the root key still lists old-shape files and reports each sealed one as unreadable', async () => {
    const s = await sampleDrive()
    const drive = await buildOwnDrive([...s.events, legacyFile('legacy1', 'old.png')], OWNER, null)
    expect(drive.files.map((f) => f.name)).toEqual(['old.png'])
    expect(drive.unreadable).toHaveLength(4)
    expect(new Set(drive.unreadable.map((u) => u.reason))).toEqual(new Set(['root key unavailable']))
  })

  it('ignores events from anyone but the owner', async () => {
    const s = await sampleDrive()
    const forged = s.events.map((e) => ({ ...e, pubkey: 'b'.repeat(64) }))
    expect((await buildOwnDrive(forged, OWNER, ROOT)).files).toEqual([])
  })
})

describe('loadOwnDrive', () => {
  it('asks the relay with one filter by author and kinds, never by #q or #d', async () => {
    const s = await sampleDrive()
    const asked: unknown[][] = []
    const query: QueryFn = async (filters) => {
      asked.push(filters)
      return s.events
    }
    const drive = await loadOwnDrive(query, OWNER, ROOT)
    expect(drive.files).toHaveLength(3)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual([expect.objectContaining({ authors: [OWNER], kinds: [5, 30078, 30079] })])
    for (const f of asked[0] as Record<string, unknown>[]) {
      expect(Object.keys(f).some((key) => key.startsWith('#'))).toBe(false)
    }
  })

  it('pages past the relay limit with until, and stops when a page adds nothing new', async () => {
    const s = await sampleDrive()
    const all = s.events.map((e, i) => ({ ...e, created_at: 1_760_000_000 + i }))
    const pages: number[] = []
    const query: QueryFn = async (filters) => {
      const f = filters[0] as { until?: number; limit: number }
      pages.push(f.until ?? -1)
      return all
        .filter((e) => f.until === undefined || e.created_at <= f.until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit)
    }
    const drive = await loadOwnDrive(query, OWNER, ROOT, { pageSize: 4 })
    expect(drive.files).toHaveLength(3)
    expect(pages.length).toBeGreaterThan(2)
  })
})

describe('listSharedFolder', () => {
  it('lists exactly the shared folder in one REQ by #q and the ring d, and reads its files and child folders', async () => {
    const s = await sampleDrive()
    const asked: Record<string, unknown>[][] = []
    const query: QueryFn = async (filters) => {
      asked.push(filters as Record<string, unknown>[])
      const qs = filters.flatMap((f) => ((f as Record<string, string[]>)['#q'] ?? []))
      const ds = filters.flatMap((f) => ((f as Record<string, string[]>)['#d'] ?? []))
      return s.events.filter((e) => e.tags.some((t) => (t[0] === 'q' && qs.includes(t[1])) || (t[0] === 'd' && ds.includes(t[1]))))
    }
    const list = await listSharedFolder(query, OWNER, s.A.id, s.A.key)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual([
      { kinds: [30078, 30079], authors: [OWNER], '#q': [await folderQ(s.A.key, s.A.id)] },
      { kinds: [30079], authors: [OWNER], '#d': [await ringD(s.A.key, s.A.id)] },
    ])
    expect(list.files.map((f) => f.name)).toEqual(['alpha.txt'])
    expect(list.folders.map((f) => f.name)).toEqual(['Beta'])
    expect(list.folderKeys.get(s.B.id)).toEqual(s.B.key)
  })

  it('with the wrong key reads nothing', async () => {
    const s = await sampleDrive()
    const list = await listSharedFolder(async () => s.events, OWNER, s.A.id, k(42))
    expect(list.files).toEqual([])
    expect(list.folders).toEqual([])
  })
})
