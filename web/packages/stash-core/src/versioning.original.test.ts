// Version history kept the original (STASH-25, found live 2026-10-19): after
// one edit, Versions listed only "v1 Collaborative edit"; the content the file
// had before the edit was never offered, so there was nothing to restore.
// History lives on this device, and the first save on a device recorded only
// the new blob. It is now seeded from the file event first: its 'v' entries,
// or, with none, its current blob as the original.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ME, relay, published, history } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  relay: { events: [] as Array<{ kind: number; created_at: number; tags: string[][]; content: string }> },
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  history: [] as Array<Record<string, unknown>>,
}))

vi.mock('./relay', () => ({ Relay: { subscribe: async () => relay.events } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: ME }),
    publishEvent: async (e: never) => { published.push(e) },
    createUploadAuth: async () => 'auth',
  },
  getSigner: () => ({}),
}))
vi.mock('./api', () => ({ API: { uploadFile: vi.fn(async () => ({ sha256: 'NEWBLOB' })) } }))
vi.mock('./fileKey', () => ({ fileKeyFor: async () => new Uint8Array(32).fill(7) }))

import { Versioning, type FileVersion } from './versioning'
import { Crypto } from './crypto'

const FID = 'file-1'
const file = { id: FID, name: 'a.txt', folder_id: 'f-1' } as never

function fileEvent(extraTags: string[][] = []) {
  return {
    kind: 30078,
    created_at: 1_800_000_000,
    tags: [['d', FID], ['x', 'ORIGBLOB'], ['ox', 'ORIGPLAIN'], ['size', '5'], ['folder', 'f-1'], ...extraTags],
    content: JSON.stringify({ name: 'a.txt', size: 5, encrypted_size: 45, encrypted: true }),
  }
}

beforeEach(async () => {
  await Crypto.init()
  published.length = 0
  history.length = 0
  // This device's history store, newest first (as getVersionHistory returns it).
  vi.spyOn(Versioning, 'getVersionHistory').mockImplementation(async () =>
    ([...history] as unknown as FileVersion[]).sort((a, b) => b.version - a.version),
  )
  vi.spyOn(Versioning, 'storeVersionMeta').mockImplementation(async (v) => {
    history.push(v as unknown as Record<string, unknown>)
  })
})

describe('the first save on a device keeps the original', () => {
  it('a file never versioned: its current blob becomes v1 "Original", the edit v2', async () => {
    relay.events = [fileEvent()]
    const created = await Versioning.createVersion(file, new Uint8Array([1, 2, 3]), { versionNote: 'Collaborative edit' })

    expect(created.version).toBe(2)
    const versions = await Versioning.getVersionHistory(FID)
    expect(versions.map((v) => [v.version, v.sha256, v.note])).toEqual([
      [2, 'NEWBLOB', 'Collaborative edit'],
      [1, 'ORIGBLOB', 'Original'],
    ])
    expect(versions[1]).toMatchObject({ plaintextHash: 'ORIGPLAIN', size: 5, encryptedSize: 45, timestamp: 1_800_000_000 })
    expect(versions[0].previousVersion).toBe('ORIGBLOB')
  })

  it('the file event records the original too, so another device sees both', async () => {
    relay.events = [fileEvent()]
    await Versioning.createVersion(file, new Uint8Array([1]))
    const v = published[0].tags.filter((t) => t[0] === 'v')
    expect(v.map((t) => [t[1], t[2]])).toEqual([['ORIGBLOB', '1'], ['NEWBLOB', '2']])
  })

  it('a file versioned on another device: its v entries seed this device, numbering continues', async () => {
    relay.events = [fileEvent([
      ['v', 'ORIGBLOB', '1', '1799999000', ME],
      ['v', 'MIDBLOB', '2', '1799999500', ME],
      ['current', 'MIDBLOB'],
    ])]
    const created = await Versioning.createVersion(file, new Uint8Array([9]))

    expect(created.version).toBe(3)
    const versions = await Versioning.getVersionHistory(FID)
    expect(versions.map((v) => [v.version, v.sha256])).toEqual([[3, 'NEWBLOB'], [2, 'MIDBLOB'], [1, 'ORIGBLOB']])
    const v = published[0].tags.filter((t) => t[0] === 'v')
    expect(v.map((t) => t[2])).toEqual(['1', '2', '3'])
  })

  it('a device that already has history is left as it is', async () => {
    relay.events = [fileEvent([['v', 'ORIGBLOB', '1', '1799999000', ME]])]
    history.push({ id: `${FID}:v1`, fileId: FID, version: 1, sha256: 'ORIGBLOB', note: 'local' })
    const created = await Versioning.createVersion(file, new Uint8Array([9]))
    expect(created.version).toBe(2)
    expect((await Versioning.getVersionHistory(FID)).map((v) => v.note)).toEqual(['', 'local'])
  })
})
