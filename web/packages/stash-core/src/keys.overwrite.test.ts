// Refuse-to-overwrite rule for key stores that opt in (FileKeyStorage).
// A headless client must never silently replace a stored key with different
// key material: every file encrypted under the old key would become
// unreadable. Same rule as the Pages CLI keystore.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Keys, KeyOverwriteRefusedError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { FileKeyStorage } from './key-storage-file'
import { InMemoryKeyStorage } from './key-storage'

const TEST_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

function mockAuth(): AuthPort {
  return {
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
}

describe('Keys: refuse-to-overwrite with FileKeyStorage', () => {
  let dir: string
  let storage: FileKeyStorage

  beforeEach(async () => {
    await Crypto.init()
    dir = mkdtempSync(join(tmpdir(), 'cloistr-keys-overwrite-'))
    storage = new FileKeyStorage(dir)
    Keys.setStorage(storage)
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true
    Keys.keyCache.clear()
  })

  afterEach(() => {
    Keys.clearCache()
    Keys.storage = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('FileKeyStorage opts in to the rule', () => {
    expect(storage.refuseOverwrite).toBe(true)
  })

  it('refuses to replace a stored key with different key material', async () => {
    const a = Crypto.generateKey()
    const b = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f1', a, 'f1')

    await expect(Keys.storeEncryptedKey('folder:f1', b, 'f1')).rejects.toBeInstanceOf(
      KeyOverwriteRefusedError,
    )
    const loaded = await Keys.loadEncryptedKey('folder:f1')
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(a))
  })

  it('allows re-storing the SAME key (re-wrap)', async () => {
    const a = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', a, null)
    await expect(Keys.storeEncryptedKey('root', a, null)).resolves.toBeUndefined()
  })

  it('refuses when the existing record cannot be decrypted', async () => {
    const a = Crypto.generateKey()
    await storage.put({
      id: `${TEST_PUBKEY}:root`,
      pubkey: TEST_PUBKEY,
      keyId: 'root',
      type: 'root',
      associatedId: null,
      encryptedKey: 'garbage-not-decryptable',
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(Keys.storeEncryptedKey('root', a, null)).rejects.toBeInstanceOf(
      KeyOverwriteRefusedError,
    )
  })

  it('replace: true overrides the rule', async () => {
    const a = Crypto.generateKey()
    const b = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', a, null)
    await Keys.storeEncryptedKey('root', b, null, { replace: true })
    Keys.keyCache.clear()
    const loaded = await Keys.loadEncryptedKey('root')
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(b))
  })

  it('deleteKey then store is allowed', async () => {
    const a = Crypto.generateKey()
    const b = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f2', a, 'f2')
    await Keys.deleteKey('folder:f2')
    await expect(Keys.storeEncryptedKey('folder:f2', b, 'f2')).resolves.toBeUndefined()
  })

  // The owner rotates a folder key when revoking someone and re-shares the
  // new one. The sender's key is authoritative for their folder, so a
  // headless recipient must take it, as the browser store already does.
  it('importSharedFolderKey replaces a previously shared key for the folder', async () => {
    const sender = 'f'.repeat(64)
    const oldKey = Crypto.generateKey()
    const newKey = Crypto.generateKey()
    await Keys.importSharedFolderKey('shared1', `nip44:${Crypto.bytesToHex(oldKey)}`, sender)
    await Keys.importSharedFolderKey('shared1', `nip44:${Crypto.bytesToHex(newKey)}`, sender)
    Keys.keyCache.clear()
    const loaded = await Keys.loadEncryptedKey('folder:shared1')
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(newKey))
  })

  // A share must not clobber a key the user owns: anyone who learns one of
  // your folder ids could otherwise make that folder unreadable to you.
  it('importSharedFolderKey refuses to replace a folder key the user owns', async () => {
    const owned = await Keys.generateFolderKey('mine1')
    const attacker = 'e'.repeat(64)
    await expect(
      Keys.importSharedFolderKey('mine1', `nip44:${Crypto.bytesToHex(Crypto.generateKey())}`, attacker),
    ).rejects.toBeInstanceOf(KeyOverwriteRefusedError)
    Keys.keyCache.clear()
    const loaded = await Keys.loadEncryptedKey('folder:mine1')
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(owned))
  })

  it('rekey() still works (deliberate replacement)', async () => {
    const root = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', root, null)
    Keys.keyCache.set('root', root)
    const folder = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f3', folder, 'f3')
    Keys.keyCache.set('folder:f3', folder)

    const { rootKey } = await Keys.rekey()
    Keys.keyCache.clear()
    const loaded = await Keys.loadEncryptedKey('root')
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(rootKey))
  })
})

describe('Keys: backends that do not opt in keep overwrite behaviour', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.setStorage(new InMemoryKeyStorage())
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.keyCache.clear()
  })

  afterEach(() => {
    Keys.clearCache()
    Keys.storage = null
  })

  it('InMemoryKeyStorage overwrite is unchanged', async () => {
    const a = Crypto.generateKey()
    const b = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', a, null)
    await Keys.storeEncryptedKey('root', b, null)
    const loaded = await Keys.loadEncryptedKey('root')
    expect(Crypto.bytesToHex(loaded!)).toBe(Crypto.bytesToHex(b))
  })
})
