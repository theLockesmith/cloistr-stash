// Phase 1 step 2b: the web app lists from the relay (one REQ by author and
// kind) instead of the server's /api/files and /api/folders.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Relay } from '@cloistr/stash-core/relay'
import { Keys } from '@cloistr/stash-core/keys'
import { Crypto } from '@cloistr/stash-core/crypto'
import { fetchDrive, filesIn, foldersIn } from './driveSource'
import { forgetDriveIndex, IndexedDBDriveIndexStore } from '@cloistr/stash-core/driveIndex'
import { rememberDrive } from '@cloistr/stash-core/sealedDrive'
import type { DriveSnapshot } from '@cloistr/stash-core/drive'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'

// Signed for real: the drive index keeps only events whose signature checks out.
const SK = new Uint8Array(32).fill(7)
const OWNER = getPublicKey(SK)
const legacyFile = (d: string, name: string, folder?: string) => {
  const { id, pubkey, sig, kind, created_at, tags, content } = finalizeEvent(
    {
      created_at: 1,
      kind: 30078,
      tags: [['d', d], ['x', 'e'.repeat(64)], ...(folder ? [['folder', folder]] : [])],
      content: JSON.stringify({ name }),
    },
    SK,
  )
  return { id, pubkey, sig, kind, created_at, tags, content }
}

vi.mock('@cloistr/stash-core/sealedDrive', async (orig) => ({
  ...(await orig<typeof import('@cloistr/stash-core/sealedDrive')>()),
  rememberDrive: vi.fn(),
}))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(rememberDrive).mockClear()
})

describe('fetchDrive', () => {
  it('asks the relay by author and kind only (paging repeats that one filter), and needs no server call', async () => {
    const query = vi.spyOn(Relay, 'query').mockResolvedValue([legacyFile('f1', 'a.txt'), legacyFile('f2', 'b.txt', 'x')])
    vi.spyOn(Keys, 'getRootKey').mockResolvedValue(new Uint8Array(32).fill(1))
    const drive = await fetchDrive(OWNER)
    // A final page that adds nothing confirms the end (fetchAll); every request is the same filter.
    expect(query).toHaveBeenCalledTimes(2)
    for (const call of query.mock.calls) {
      expect(call[0]).toEqual([expect.objectContaining({ authors: [OWNER], kinds: [5, 30078, 30079] })])
    }
    expect(filesIn(drive, '').map((f) => f.name)).toEqual(['a.txt'])
    expect(filesIn(drive, 'x').map((f) => f.name)).toEqual(['b.txt'])
  })

  it('still lists old-shape files when the root key cannot be loaded', async () => {
    vi.spyOn(Relay, 'query').mockResolvedValue([legacyFile('f1', 'a.txt')])
    vi.spyOn(Keys, 'getRootKey').mockRejectedValue(new Error('signer unavailable'))
    expect(filesIn(await fetchDrive(OWNER), '').map((f) => f.name)).toEqual(['a.txt'])
  })

  it('fails loudly when the relay does not answer, so the UI shows an error and not an empty drive', async () => {
    vi.spyOn(Relay, 'query').mockRejectedValue(new Error('Subscription timeout'))
    vi.spyOn(Keys, 'getRootKey').mockResolvedValue(new Uint8Array(32))
    await expect(fetchDrive(OWNER)).rejects.toThrow('Subscription timeout')
  })
})

// One page load asks for the drive from the list, the folder tree and the
// views at once: that must be one relay read, never a stale or foreign one.
describe('fetchDrive shares one read', () => {
  const OTHER = getPublicKey(new Uint8Array(32).fill(8))
  // A relay that answers once released. Without the root key the listing is
  // a plain full read: a page, then an empty page that ends it.
  function heldRelay() {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const query = vi.spyOn(Relay, 'query').mockImplementation(async () => (await gate, [legacyFile('f1', 'a.txt')]))
    vi.spyOn(Keys, 'getRootKey').mockRejectedValue(new Error('signer unavailable'))
    return { query, release }
  }
  const authorsOf = (call: unknown[]) => (call[0] as { authors: string[] }[])[0].authors

  it('calls made while a read runs share it: one relay read', async () => {
    const { query, release } = heldRelay()
    const reads = [fetchDrive(OWNER), fetchDrive(OWNER), fetchDrive(OWNER)]
    release()
    for (const d of await Promise.all(reads)) expect(filesIn(d, '').map((f) => f.name)).toEqual(['a.txt'])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('a call after the read finished starts a new one', async () => {
    const { query, release } = heldRelay()
    release()
    await fetchDrive(OWNER)
    await fetchDrive(OWNER)
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('a call after a publish does not join a read started before it (a refresh must see the write)', async () => {
    const { query, release } = heldRelay()
    const before = fetchDrive(OWNER)
    Relay.published++ // as Relay.publish does
    const after = fetchDrive(OWNER)
    release()
    await Promise.all([before, after])
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('after sign-out, a read started before it is neither joined nor remembered', async () => {
    const { query, release } = heldRelay()
    const old = fetchDrive(OWNER)
    await forgetDriveIndex(OWNER)
    const fresh = fetchDrive(OWNER)
    release()
    await Promise.all([old, fresh])
    expect(query).toHaveBeenCalledTimes(4)
    expect(rememberDrive).toHaveBeenCalledTimes(1)
  })

  it('a sign-out while the root key loads leaves no index for the old session', async () => {
    await Crypto.init()
    vi.spyOn(Relay, 'query').mockResolvedValue([legacyFile('f1', 'a.txt')])
    let giveKey!: (k: Uint8Array) => void
    vi.spyOn(Keys, 'getRootKey').mockReturnValue(new Promise((r) => (giveKey = r)))
    vi.spyOn(IndexedDBDriveIndexStore.prototype, 'get').mockResolvedValue(null)
    vi.spyOn(IndexedDBDriveIndexStore.prototype, 'delete').mockResolvedValue()
    const put = vi.spyOn(IndexedDBDriveIndexStore.prototype, 'put').mockResolvedValue()
    const old = fetchDrive(OWNER)
    await forgetDriveIndex(OWNER)
    giveKey(new Uint8Array(32).fill(1))
    await old
    expect(put).not.toHaveBeenCalled()
    expect(rememberDrive).not.toHaveBeenCalled()
  })

  it("another account never gets this account's read", async () => {
    const { query, release } = heldRelay()
    const mine = fetchDrive(OWNER)
    const theirs = fetchDrive(OTHER)
    release()
    await Promise.all([mine, theirs])
    expect(query.mock.calls.map(authorsOf).flat().sort()).toEqual([OTHER, OTHER, OWNER, OWNER].sort())
    expect(vi.mocked(rememberDrive).mock.calls.map((c) => c[0]).sort()).toEqual([OTHER, OWNER].sort())
  })
})

describe('filesIn / foldersIn', () => {
  const snap = {
    files: [
      { sha256: 's'.repeat(64), id: 'live', name: 'live', folder_id: '' },
      { sha256: 's'.repeat(64), id: 'trashed', name: 'trashed', folder_id: '', deleted_at: 5 },
    ],
    folders: [
      { id: 'top', name: 'top' },
      { id: 'child', name: 'child', parent_id: 'top' },
    ],
    fileKeys: new Map(),
    folderKeys: new Map(),
    unreadable: [],
  } as unknown as DriveSnapshot

  it('filesIn keeps one folder level and leaves trashed files out', () => {
    expect(filesIn(snap, '').map((f) => f.id)).toEqual(['live'])
  })

  it('foldersIn returns the direct children only', () => {
    expect(foldersIn(snap, '').map((f) => f.id)).toEqual(['top'])
    expect(foldersIn(snap, 'top').map((f) => f.id)).toEqual(['child'])
  })
})
