// Phase 1 step 2b: the web app lists from the relay (one REQ by author and
// kind) instead of the server's /api/files and /api/folders.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Relay } from '@cloistr/stash-core/relay'
import { Keys } from '@cloistr/stash-core/keys'
import { fetchDrive, filesIn, foldersIn } from './driveSource'
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

beforeEach(() => vi.restoreAllMocks())

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
