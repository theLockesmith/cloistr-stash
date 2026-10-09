// Every path that USES an own folder key goes through Keys.resolveOwnFolderKey
// (the relay copy is authoritative), and share acceptance hands Keys a relay
// ownership check. Real Keys + Crypto; relay and signer are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, MALLORY, published, relay, subscribe } = vi.hoisted(() => {
  const relay = { events: [] as Array<{ kind: number; tags: string[][]; content: string }> }
  return {
    ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
    MALLORY: 'e'.repeat(64),
    published: [] as Array<{ kind: number; tags: string[][] }>,
    relay,
    subscribe: vi.fn(async (..._a: unknown[]) => relay.events),
  }
})

vi.mock('./relay', () => ({ Relay: { subscribe: (...a: unknown[]) => subscribe(...a) } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: ME }),
    publishEvent: async (e: { kind: number; tags: string[][] }) => {
      published.push(e)
    },
  },
  getSigner: () => ({}),
}))

import { Keys, KeyOverwriteRefusedError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { addWrappedKeyToFolder } from './upload'
import { Sharing } from './sharing'

const enc = (key: Uint8Array) => `nip44:${Crypto.bytesToHex(key)}`
const hex = (k: Uint8Array) => Crypto.bytesToHex(k)

beforeEach(async () => {
  await Crypto.init()
  Keys.setStorage(new InMemoryKeyStorage())
  const auth: AuthPort = {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => {
      if (!ct.startsWith('nip44:')) throw new Error('bad ciphertext')
      return ct.replace('nip44:', '')
    }),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
  }
  Keys.configure({ auth })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  published.length = 0
  relay.events = []
  subscribe.mockClear()
})

afterEach(() => {
  Keys.clearCache()
  Keys.storage = null
})

describe('upload into an own folder on a poisoned browser', () => {
  it('wraps the new file key under the real folder key from the relay, not the local one', async () => {
    const real = Crypto.generateKey()
    const attacker = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-mine', attacker, 'f-mine', { sharedBy: MALLORY })
    relay.events = [{ kind: 30079, tags: [['d', 'f-mine'], ['key', enc(real)]], content: '{"name":"mine"}' }]

    const fileKey = Crypto.generateKey()
    await addWrappedKeyToFolder('f-mine', 'file-1', fileKey)

    const ev = published.find((e) => e.kind === 30079)!
    const wk = ev.tags.find((t) => t[0] === 'wk' && t[1] === 'file-1')!
    expect(hex(Keys.unwrapFileKeyFromFolder(wk[2], 'file-1', real))).toBe(hex(fileKey))
    expect(() => Keys.unwrapFileKeyFromFolder(wk[2], 'file-1', attacker)).toThrow()
    // the relay key tag is republished unchanged
    expect(ev.tags.find((t) => t[0] === 'key')?.[1]).toBe(enc(real))
  })
})

describe('accepting a folder share', () => {
  const folderShare = (folderId: string, key: Uint8Array) => ({
    id: 'share-1',
    owner_pubkey: MALLORY,
    encrypted_content: JSON.stringify({ type: 'folder', folderId, folderName: 'x', folderKey: enc(key) }),
  })

  it('asks the relay whether the folder is the user\'s own (authors = me, #d = folder id)', async () => {
    await Keys.storeEncryptedKey('folder:f-old', Crypto.generateKey(), 'f-old') // pre-provenance record
    relay.events = [{ kind: 30079, tags: [['d', 'f-old']], content: '{}' }]
    vi.spyOn(Sharing, 'decryptFromSender').mockImplementation(async (_pk: string, ct: string) =>
      ct.startsWith('nip44:') ? ct.replace('nip44:', '') : ct,
    )

    await expect(
      Sharing.acceptShare(folderShare('f-old', Crypto.generateKey()) as never),
    ).rejects.toBeInstanceOf(KeyOverwriteRefusedError)
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: [30079], authors: [ME], '#d': ['f-old'] }),
      expect.any(Number),
    )
  })
})
