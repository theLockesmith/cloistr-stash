// File edits re-publish a replaceable event (kind 30078, d=fileId). Found in
// the 2026-10-09 sweep: rename/move/trash/restore/tag rebuilt it from the list
// row, dropping owner_key (a wrapped file's ONLY key copy: permanently
// undecryptable) and the v/current version tags. Every edit now starts from
// the event as loaded from the relay, and refuses when it cannot load it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, relay, published, subscribe, signer } = vi.hoisted(() => {
  const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
  const relay = { events: [] as Array<{ kind: number; created_at: number; tags: string[][]; content: string }> }
  const signer = {
    async getPublicKey() { return ME },
    async signEvent(e: unknown) { return e },
    async encrypt(_pk: string, pt: string) { return `nip04:${pt}` },
    async decrypt(_pk: string, ct: string) { return ct.replace('nip04:', '') },
    async nip44Encrypt(_pk: string, pt: string) { return `nip44:${pt}` },
    async nip44Decrypt(_pk: string, ct: string) { return ct.replace('nip44:', '') },
  }
  return { ME, relay, signer, published: [] as Array<{ kind: number; created_at: number; tags: string[][]; content: string }>, subscribe: vi.fn() }
})

vi.mock('./relay', () => ({ Relay: { subscribe: (...a: unknown[]) => subscribe(...a) } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: ME }),
    publishEvent: async (e: never) => { published.push(e) },
  },
  getSigner: () => signer,
}))

import { renameFile, moveFile, softDeleteFile, restoreFile, setFileTags, renameFolder, FileEventUnavailableError } from './operations'
import { Keys } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import type { StashFile } from './types'

const FID = 'file-1'
// The file as the relay holds it: wrapped key, version history, a tag the list row never carries.
const onRelay = (extra: string[][] = []) => ({
  kind: 30078,
  created_at: 1_800_000_000,
  tags: [
    ['d', FID], ['x', 'blobhash'], ['m', 'text/plain'], ['size', '5'], ['encrypted', 'xchacha20-poly1305'],
    ['ox', 'plainhash'], ['v', 'blobhash', '2', '1799999999', ME], ['current', 'blobhash'],
    ['owner_key', 'ENVELOPE'], ['future-tag', 'kept'], ...extra,
  ],
  content: JSON.stringify({ name: 'a.txt', size: 5, encrypted_size: 45, mime_type: 'text/plain', encrypted: true, future: 1 }),
})
// The list row the UI holds: none of owner_key / v / current / future-tag.
const row = { id: FID, sha256: 'blobhash', name: 'a.txt', size: 5, mime_type: 'text/plain' } as unknown as StashFile
const tag = (e: { tags: string[][] }, n: string) => e.tags.filter((t) => t[0] === n)

function expectKept(e: { tags: string[][]; content: string }) {
  expect(tag(e, 'owner_key')).toEqual([['owner_key', 'ENVELOPE']])
  expect(tag(e, 'v')).toEqual([['v', 'blobhash', '2', '1799999999', ME]])
  expect(tag(e, 'current')).toEqual([['current', 'blobhash']])
  expect(tag(e, 'ox')).toEqual([['ox', 'plainhash']])
  expect(tag(e, 'future-tag')).toEqual([['future-tag', 'kept']])
  expect(JSON.parse(e.content).future).toBe(1)
}

beforeEach(() => {
  published.length = 0
  relay.events = [onRelay()]
  subscribe.mockReset()
  subscribe.mockImplementation(async () => relay.events)
})

describe('each edit keeps the key copy, version history and unknown fields', () => {
  it('rename', async () => {
    await renameFile(row, 'b.txt')
    expectKept(published[0])
    expect(JSON.parse(published[0].content).name).toBe('b.txt')
  })

  it('move (a wrapped file keeps its owner_key; no new wrap)', async () => {
    await moveFile(row, 'folder-2')
    expectKept(published[0])
    expect(tag(published[0], 'folder')).toEqual([['folder', 'folder-2']])
  })

  it('trash', async () => {
    await softDeleteFile(row)
    expectKept(published[0])
    expect(tag(published[0], 'deleted_at')).toHaveLength(1)
    expect(JSON.parse(published[0].content).deleted_at).toBeGreaterThan(0)
  })

  it('restore', async () => {
    relay.events = [onRelay([['deleted_at', '1800000000']])]
    await restoreFile({ ...row, deleted_at: 1800000000 } as StashFile)
    expectKept(published[0])
    expect(tag(published[0], 'deleted_at')).toEqual([])
    expect(JSON.parse(published[0].content).deleted_at).toBeUndefined()
  })

  it('set tags', async () => {
    await setFileTags(row, ['Work'])
    expectKept(published[0])
    expect(tag(published[0], 't')).toEqual([['t', 'work']])
  })

  it('the new event is strictly newer than the one it replaces', async () => {
    relay.events = [onRelay()]
    relay.events[0].created_at = Math.floor(Date.now() / 1000) + 3600 // relay copy from a clock ahead of ours
    await renameFile(row, 'b.txt')
    expect(published[0].created_at).toBe(relay.events[0].created_at + 1)
  })
})

describe('an edit that cannot load the current event changes nothing', () => {
  it('relay timeout: refused, nothing published', async () => {
    subscribe.mockRejectedValue(new Error('Subscription timeout'))
    for (const op of [() => renameFile(row, 'b'), () => moveFile(row, 'f'), () => softDeleteFile(row), () => restoreFile(row), () => setFileTags(row, ['x'])]) {
      await expect(op()).rejects.toBeInstanceOf(FileEventUnavailableError)
    }
    expect(published).toEqual([])
  })

  it('relay has no event for the file: refused, nothing published', async () => {
    relay.events = []
    await expect(renameFile(row, 'b')).rejects.toBeInstanceOf(FileEventUnavailableError)
    expect(published).toEqual([])
  })
})

describe('moving a legacy (derived-key) file', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.setStorage(new InMemoryKeyStorage())
    Keys.configure({
      auth: {
        isConnected: true,
        nip04Encrypt: async (_pk, pt) => `nip04:${pt}`,
        nip04Decrypt: async (_pk, ct) => ct.replace('nip04:', ''),
        nip44Encrypt: async (_pk, pt) => `nip44:${pt}`,
        nip44Decrypt: async (_pk, ct) => ct.replace('nip44:', ''),
        createRootKeyEvent: async () => ({}),
        publishEvent: async () => {},
      },
    })
    Keys.userPubkey = ME
    Keys.keyCache.clear()
  })
  afterEach(() => {
    Keys.clearCache()
    Keys.storage = null
  })

  it('first wraps its CURRENT key to the owner, so it still opens after the move', async () => {
    const root = Crypto.generateKey()
    Keys.keyCache.set('root', root)
    const legacy = onRelay([['folder', 'folder-1']])
    legacy.tags = legacy.tags.filter((t) => t[0] !== 'owner_key')
    relay.events = [legacy]
    const before = await Keys.getFileKey('folder-1', FID)

    await moveFile(row, 'folder-2')

    const env = tag(published[0], 'owner_key')[0]?.[1]
    expect(env).toBeTruthy()
    const after = await Keys.getFileKey('folder-2', FID, { ownerEnvelope: env, signer })
    expect(Crypto.bytesToHex(after)).toBe(Crypto.bytesToHex(before))
    expect(tag(published[0], 'folder')).toEqual([['folder', 'folder-2']])
  })
})

// Sweep item #11: renaming a folder rebuilt its event and dropped every wk tag.
describe('renameFolder keeps the folder key and every wrapped file key', () => {
  it('only the name changes', async () => {
    relay.events = [{
      kind: 30079,
      created_at: 1_800_000_000,
      tags: [['d', 'folder-1'], ['encrypted', 'true'], ['parent', 'p'], ['key', 'KEYTAG'], ['wk', 'f1', 'E1'], ['wk', 'f2', 'E2']],
      content: JSON.stringify({ name: 'old', description: 'desc', encrypted: true }),
    }]
    await renameFolder({ id: 'folder-1', name: 'old', encrypted_key: 'KEYTAG' } as never, 'new')
    const e = published[0]
    expect(e.kind).toBe(30079)
    expect(e.tags).toEqual(relay.events[0].tags)
    expect(JSON.parse(e.content)).toEqual({ name: 'new', description: 'desc', encrypted: true })
  })

  it('relay timeout: refused, nothing published', async () => {
    subscribe.mockRejectedValue(new Error('Subscription timeout'))
    await expect(renameFolder({ id: 'folder-1', name: 'old' } as never, 'new')).rejects.toBeInstanceOf(FileEventUnavailableError)
    expect(published).toEqual([])
  })
})
