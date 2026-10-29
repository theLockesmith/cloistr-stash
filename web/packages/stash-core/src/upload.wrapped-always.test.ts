// Key model (architecture/key-model.md): new files use random keys, wrapped to
// the owner on the file event and under the folder key in the folder event.
// Upload chose on Keys.wrappedKeyMode, which is false until the migration
// record has been read from the relay, so an upload on a fresh device in the
// first seconds after sign-in got an HKDF-derived key and no owner envelope.
// Same gap in revoke. These pin the choice to "always wrap", flag or not.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, published, relay, uploaded } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  relay: { events: [] as Array<{ kind: number; tags: string[][]; content: string }> },
  uploaded: [] as Uint8Array[],
}))

const signer = {
  getPublicKey: async () => ME,
  nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
  nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
}

vi.mock('./relay', () => ({ Relay: { subscribe: async () => relay.events, query: async () => [] } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    createUploadAuth: async () => 'Nostr x',
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: ME }),
    publishEvent: async (e: { kind: number; tags: string[][]; content: string }) => {
      published.push(e)
    },
  },
  getSigner: () => signer,
}))
vi.mock('./api', () => ({
  API: {
    uploadFile: async (file: File) => {
      uploaded.push(new Uint8Array(await file.arrayBuffer()))
      return {}
    },
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
    deleteFile: async () => ({}),
  },
}))
vi.mock('./search', () => ({ Search: { indexFile: async () => {} } }))
vi.mock('./sealedDrive', () => ({ writesSealed: async () => false, writeContext: async () => ({}) }))

import { Keys } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { uploadEncryptedBytes, uploadFiles } from './upload'

const hex = (k: Uint8Array) => Crypto.bytesToHex(k)
const fileEvent = () => published.filter((e) => e.kind === 30078).pop()!
const tag = (ev: { tags: string[][] }, name: string) => ev.tags.find((t) => t[0] === name)?.[1]
const fileIdOf = (ev: { tags: string[][] }) => tag(ev, 'd')!

let folderKey: Uint8Array

beforeEach(async () => {
  await Crypto.init()
  Keys.setStorage(new InMemoryKeyStorage())
  const auth: AuthPort = {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
  }
  Keys.configure({ auth })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  // A fresh device: the migration record has not been read yet.
  Keys.wrappedKeyMode = false
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  folderKey = Crypto.generateKey()
  relay.events = [{ kind: 30079, tags: [['d', 'f-1'], ['key', `nip44:${hex(folderKey)}`]], content: '{"name":"f"}' }]
  published.length = 0
  uploaded.length = 0
})

afterEach(() => {
  Keys.clearCache()
  Keys.storage = null
})

/** The key the owner recovers from the file event's own envelope, and that it opens the blob. */
async function ownerOpens(): Promise<Uint8Array> {
  const ev = fileEvent()
  const envelope = tag(ev, 'owner_key')
  expect(envelope, 'file event carries an owner envelope').toBeTruthy()
  const key = await Keys.unwrapFileKeyFromOwner(envelope!, fileIdOf(ev), signer)
  await Crypto.decryptFile(uploaded[uploaded.length - 1], key)
  return key
}

describe('new uploads always use a random, wrapped key (before the migration flag is known)', () => {
  it('uploadFiles into a folder: owner envelope on the file, wk under the folder key, not the derived key', async () => {
    const items = await uploadFiles([new File(['hello'], 'a.txt')], { folderId: 'f-1' })
    expect(items[0].status).toBe('success')

    const key = await ownerOpens()
    const fileId = fileIdOf(fileEvent())
    expect(hex(key)).not.toBe(hex(await Keys.deriveFileKey('f-1', fileId)))

    const folder = published.filter((e) => e.kind === 30079).pop()!
    const wk = folder.tags.find((t) => t[0] === 'wk' && t[1] === fileId)
    expect(wk, 'folder event carries the wrapped key').toBeTruthy()
    expect(hex(Keys.unwrapFileKeyFromFolder(wk![2], fileId, folderKey))).toBe(hex(key))
  })

  it('uploadFiles at the root: owner envelope, not the derived root key', async () => {
    const items = await uploadFiles([new File(['hello'], 'b.txt')], { folderId: null })
    expect(items[0].status).toBe('success')
    const key = await ownerOpens()
    expect(hex(key)).not.toBe(hex(await Keys.deriveRootFileKey(fileIdOf(fileEvent()))))
  })

  it('uploadEncryptedBytes: owner envelope and folder wk, not the derived key', async () => {
    await uploadEncryptedBytes(new Uint8Array([1, 2, 3]), 'c.bin', 'application/octet-stream', 'f-1')
    const key = await ownerOpens()
    const fileId = fileIdOf(fileEvent())
    expect(hex(key)).not.toBe(hex(await Keys.deriveFileKey('f-1', fileId)))
    const folder = published.filter((e) => e.kind === 30079).pop()!
    expect(folder.tags.some((t) => t[0] === 'wk' && t[1] === fileId)).toBe(true)
  })
})
