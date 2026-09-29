import { describe, it, expect, beforeEach } from 'vitest'
import { Keys } from './keys'
import { InMemoryKeyStorage } from './key-storage'
import { Crypto } from './crypto'

function fakeAuth() {
  return {
    isConnected: true,
    nip04Encrypt: async (_pk: string, pt: string) => `nip04:${pt}`,
    nip04Decrypt: async (_pk: string, ct: string) => ct.replace('nip04:', ''),
    nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
    nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
    createRootKeyEvent: async (ek: string) => ({ kind: 30078, content: ek }),
    publishEvent: async () => {},
  }
}

const PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

describe('Headless key round-trip (no IndexedDB)', () => {
  let storage: InMemoryKeyStorage

  beforeEach(async () => {
    await Crypto.init()
    storage = new InMemoryKeyStorage()
    Keys.setStorage(storage)
    Keys.keyCache.clear()
    Keys.userPubkey = PUBKEY
    Keys.nip44Writes = true
    Keys.configure({ auth: fakeAuth(), api: null })
  })

  it('store + load key round-trips through in-memory storage', async () => {
    const key = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', key, null)

    Keys.keyCache.clear()
    const loaded = await Keys.loadEncryptedKey('root')

    expect(loaded).toEqual(key)
  })

  it('keys are encrypted at rest in storage', async () => {
    const key = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', key, null)

    const record = await storage.get(`${PUBKEY}:root`)
    expect(record).not.toBeNull()
    expect(record!.encryptedKey).toMatch(/^nip44:/)
    expect(record!.encryptedKey).not.toBe(Crypto.bytesToHex(key))
  })

  it('full encrypt-decrypt cycle works headlessly', async () => {
    const rootKey = Crypto.generateKey()
    Keys.keyCache.set('root', rootKey)

    const folderId = 'headless-folder'
    const fileId = 'headless-file'

    const folderKey = await Keys.deriveKey(rootKey, folderId, 'cloistr-drive-folder-v1')
    Keys.keyCache.set(`folder:${folderId}`, folderKey)

    const fileKey = await Keys.deriveKey(folderKey, fileId, 'cloistr-drive-file-v1')

    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const encrypted = await Crypto.encryptFile(plaintext, fileKey)
    const decrypted = await Crypto.decryptFile(encrypted, fileKey)

    expect(decrypted).toEqual(plaintext)
  })

  it('delete key removes from storage', async () => {
    const key = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:abc', key, 'abc')

    await Keys.deleteKey('folder:abc')

    const loaded = await Keys.loadEncryptedKey('folder:abc')
    expect(loaded).toBeNull()
  })
})
