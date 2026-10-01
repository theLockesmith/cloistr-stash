import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys } from './keys'
import { Crypto } from './crypto'
import type { AuthPort } from './keys'
import { InMemoryKeyStorage } from './key-storage'

const TEST_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

function mockAuth(): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
  }
}

describe('headless key storage', () => {
  let storage: InMemoryKeyStorage

  beforeEach(async () => {
    storage = new InMemoryKeyStorage()
    Keys.setStorage(storage)
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true
    Keys.keyCache.clear()
    await Crypto.init()
  })

  afterEach(() => {
    Keys.clearCache()
    Keys.storage = null
  })

  it('store + load round-trip returns the same key material', async () => {
    const key = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', key, null)
    Keys.keyCache.clear()

    const loaded = await Keys.loadEncryptedKey('root')
    expect(loaded).not.toBeNull()
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(key))
  })

  it('stored records are encrypted, not raw key material', async () => {
    const key = Crypto.generateKey()
    const keyHex = Crypto.bytesToHex(key)
    await Keys.storeEncryptedKey('root', key, null)

    const record = await storage.get(`${TEST_PUBKEY}:root`)
    expect(record).not.toBeNull()
    expect(record!.encryptedKey).not.toBe(keyHex)
    expect(record!.encryptedKey).toMatch(/^nip44:/)
  })

  it('full encrypt-decrypt cycle through HKDF', async () => {
    const key = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', key, null)
    Keys.keyCache.set('root', key)

    const folderId = 'test-folder-id'
    const fileId = 'test-file-id'
    const folderKey = await Keys.deriveKey(key, folderId, Keys.CONTEXT_FOLDER)
    const fileKey = await Keys.deriveKey(folderKey, fileId, Keys.CONTEXT_FILE)

    const plaintext = new TextEncoder().encode('hello stash')
    const ciphertext = await Crypto.encryptFile(plaintext, fileKey)
    const decrypted = await Crypto.decryptFile(ciphertext, fileKey)
    expect(new TextDecoder().decode(decrypted)).toBe('hello stash')
  })

  it('delete removes the key from storage', async () => {
    const key = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', key, null)
    await Keys.deleteKey('root')

    const loaded = await Keys.loadEncryptedKey('root')
    expect(loaded).toBeNull()
    const record = await storage.get(`${TEST_PUBKEY}:root`)
    expect(record).toBeNull()
  })
})
