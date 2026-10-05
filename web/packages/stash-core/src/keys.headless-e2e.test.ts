import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys } from './keys'
import { Crypto } from './crypto'
import type { AuthPort } from './keys'
import { FileKeyStorage } from './key-storage-file'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

describe('headless E2E: cross-process persistence', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stash-keys-'))
    await Crypto.init()
  })

  afterEach(async () => {
    Keys.clearCache()
    Keys.storage = null
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('process B reads keys written by process A and decrypts data', async () => {
    const folderId = 'folder-abc'
    const fileId = 'file-xyz'
    const plaintext = new TextEncoder().encode('cross-process secret')

    // --- Process A: generate keys, encrypt, persist ---
    const storageA = new FileKeyStorage(tmpDir)
    Keys.setStorage(storageA)
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true
    Keys.keyCache.clear()

    const rootKey = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', rootKey, null)
    Keys.keyCache.set('root', rootKey)

    const folderKey = await Keys.deriveKey(rootKey, folderId, Keys.CONTEXT_FOLDER)
    await Keys.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId)

    const fileKey = await Keys.deriveKey(folderKey, fileId, Keys.CONTEXT_FILE)
    const ciphertext = await Crypto.encryptFile(plaintext, fileKey)

    // Wipe process A state
    Keys.clearCache()
    Keys.storage = null

    // --- Process B: fresh instance, same directory ---
    const storageB = new FileKeyStorage(tmpDir)
    Keys.setStorage(storageB)
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true

    // Load root key from file storage
    const loadedRoot = await Keys.loadEncryptedKey('root')
    expect(loadedRoot).not.toBeNull()
    Keys.keyCache.set('root', loadedRoot!)

    // Derive folder key from root (deterministic via HKDF)
    const derivedFolder = await Keys.deriveKey(loadedRoot!, folderId, Keys.CONTEXT_FOLDER)

    // Derive file key from folder
    const derivedFile = await Keys.deriveKey(derivedFolder, fileId, Keys.CONTEXT_FILE)

    // Decrypt with derived key
    const decrypted = await Crypto.decryptFile(ciphertext, derivedFile)
    expect(new TextDecoder().decode(decrypted)).toBe('cross-process secret')
  })
})
