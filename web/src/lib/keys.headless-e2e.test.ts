import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Keys } from './keys'
import { FileKeyStorage } from './key-storage-file'
import { Crypto } from './crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

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

function resetKeys(keyDir: string) {
  Keys.keyCache.clear()
  Keys.userPubkey = PUBKEY
  Keys.nip44Writes = true
  Keys.storage = null
  Keys.setStorage(new FileKeyStorage(keyDir))
  Keys.configure({ auth: fakeAuth(), api: null })
}

describe('Headless E2E: cross-process key persistence', () => {
  let keyDir: string

  beforeEach(async () => {
    await Crypto.init()
    keyDir = mkdtempSync(join(tmpdir(), 'cloistr-headless-e2e-'))
  })

  afterEach(() => {
    Keys.storage = null
    rmSync(keyDir, { recursive: true, force: true })
  })

  it('process B opens a file encrypted by process A', async () => {
    const folderId = 'shared-folder'
    const fileId = 'shared-file'
    const plaintext = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])

    // ── Process A: generate keys, encrypt, persist keys to disk ──
    resetKeys(keyDir)

    const rootKey = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', rootKey, null)
    Keys.keyCache.set('root', rootKey)

    const folderKey = await Keys.deriveKey(rootKey, folderId, 'cloistr-drive-folder-v1')
    await Keys.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId)
    Keys.keyCache.set(`folder:${folderId}`, folderKey)

    const fileKey = await Keys.deriveKey(folderKey, fileId, 'cloistr-drive-file-v1')
    const encrypted = await Crypto.encryptFile(plaintext, fileKey)

    // ── Process B: fresh instance, same key directory ──
    resetKeys(keyDir)
    // Cache is empty, keys must come from disk

    const loadedRoot = await Keys.loadEncryptedKey('root')
    expect(loadedRoot).toEqual(rootKey)
    Keys.keyCache.set('root', loadedRoot!)

    const loadedFolder = await Keys.loadEncryptedKey(`folder:${folderId}`)
    expect(loadedFolder).toEqual(folderKey)
    Keys.keyCache.set(`folder:${folderId}`, loadedFolder!)

    const recoveredFileKey = await Keys.deriveKey(loadedFolder!, fileId, 'cloistr-drive-file-v1')
    const decrypted = await Crypto.decryptFile(encrypted, recoveredFileKey)

    expect(decrypted).toEqual(plaintext)
  })

  it('process B decrypts with getFileKey fallback chain', async () => {
    const folderId = 'gfk-folder'
    const fileId = 'gfk-file'
    const plaintext = new Uint8Array([99, 88, 77, 66])

    // ── Process A ──
    resetKeys(keyDir)
    const rootKey = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', rootKey, null)
    Keys.keyCache.set('root', rootKey)

    const folderKey = await Keys.deriveKey(rootKey, folderId, 'cloistr-drive-folder-v1')
    await Keys.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId)

    const fileKey = Keys.generateFileKey()
    const envelope = Keys.wrapFileKeyForFolder(fileKey, fileId, folderKey)
    const encrypted = await Crypto.encryptFile(plaintext, fileKey)

    // ── Process B ──
    resetKeys(keyDir)

    const loadedRoot = await Keys.loadEncryptedKey('root')
    Keys.keyCache.set('root', loadedRoot!)
    const loadedFolder = await Keys.loadEncryptedKey(`folder:${folderId}`)
    Keys.keyCache.set(`folder:${folderId}`, loadedFolder!)

    const recovered = await Keys.getFileKey(folderId, fileId, {
      folderWrappedKeys: [{ subject: fileId, envelope }],
    })
    const decrypted = await Crypto.decryptFile(encrypted, recovered)

    expect(decrypted).toEqual(plaintext)
  })
})
