// Saving a new version re-published the file event from the in-memory file,
// dropping owner_key (a wrapped file's only key copy) and every earlier 'v'
// entry (found 2026-10-09). It now merges into the event loaded from the relay.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ME, relay, published, subscribe } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  relay: { events: [] as Array<{ kind: number; created_at: number; tags: string[][]; content: string }> },
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  subscribe: vi.fn(),
}))

vi.mock('./relay', () => ({ Relay: { subscribe: (...a: unknown[]) => subscribe(...a) } }))
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

import { Versioning } from './versioning'
import { API } from './api'
import { Crypto } from './crypto'

const FID = 'file-1'

beforeEach(async () => {
  await Crypto.init()
  published.length = 0
  subscribe.mockReset()
  subscribe.mockImplementation(async () => relay.events)
  relay.events = [{
    kind: 30078,
    created_at: 1_800_000_000,
    tags: [['d', FID], ['x', 'OLDBLOB'], ['size', '3'], ['encrypted', 'xchacha20-poly1305'], ['folder', 'f-1'],
      ['owner_key', 'ENVELOPE'], ['t', 'work'], ['v', 'OLDBLOB', '1', '1799999999', ME], ['current', 'OLDBLOB']],
    content: JSON.stringify({ name: 'a.txt', size: 3, encrypted: true }),
  }]
  vi.spyOn(Versioning, 'getVersionHistory').mockResolvedValue([{ sha256: 'OLDBLOB' }] as never)
  vi.spyOn(Versioning, 'storeVersionMeta').mockResolvedValue()
  vi.mocked(API.uploadFile).mockClear()
})

describe('createVersion merges into the current file event', () => {
  it('keeps owner_key, earlier versions and user tags; updates the blob fields', async () => {
    await Versioning.createVersion({ id: FID, name: 'a.txt', folder_id: 'f-1' } as never, new Uint8Array([1, 2, 3, 4]))
    const e = published[0]
    const tags = (n: string) => e.tags.filter((t) => t[0] === n)
    expect(tags('owner_key')).toEqual([['owner_key', 'ENVELOPE']])
    expect(tags('t')).toEqual([['t', 'work']])
    expect(tags('v').map((t) => t[2])).toEqual(['1', '2'])
    expect(tags('current')).toEqual([['current', 'NEWBLOB']])
    expect(tags('x')).toEqual([['x', 'NEWBLOB']])
    expect(JSON.parse(e.content).name).toBe('a.txt')
  })

  it('relay does not answer: nothing is uploaded or published', async () => {
    subscribe.mockRejectedValue(new Error('Subscription timeout'))
    await expect(
      Versioning.createVersion({ id: FID, name: 'a.txt' } as never, new Uint8Array([1])),
    ).rejects.toThrow(/Nothing was changed/)
    expect(API.uploadFile).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })
})
