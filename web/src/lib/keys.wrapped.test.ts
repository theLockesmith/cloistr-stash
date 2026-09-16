import { describe, it, expect, beforeEach } from 'vitest'
import { Keys } from './keys'
import { Crypto } from './crypto'
import { generateContentKey, type Envelope } from '@cloistr/auth'

// x-only pubkey (64 hex chars), the format Nostr and @cloistr/auth expect
const TEST_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

function makeSigner(pubkey: string) {
  return {
    async getPublicKey() { return pubkey },
    async signEvent(event: unknown) { return event },
    async encrypt(pk: string, pt: string) { return `nip04:${pt}` },
    async decrypt(pk: string, ct: string) { return ct.replace('nip04:', '') },
    async nip44Encrypt(pk: string, pt: string) { return `nip44:${pt}` },
    async nip44Decrypt(pk: string, ct: string) { return ct.replace('nip44:', '') },
  }
}

async function primeKeysWithRoot(): Promise<Uint8Array> {
  const rootKey = Crypto.generateKey()
  Keys.keyCache.set('root', rootKey)
  return rootKey
}

async function deriveFolderKeyManually(rootKey: Uint8Array, folderId: string): Promise<Uint8Array> {
  const folderKey = await Keys.deriveKey(rootKey, folderId, 'cloistr-drive-folder-v1')
  Keys.keyCache.set(`folder:${folderId}`, folderKey)
  return folderKey
}

describe('Keys: envelope wrapping', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
    Keys.userPubkey = TEST_PUBKEY
    Keys.wrappedKeyMode = false
  })

  it('generateFileKey returns a 32-byte random key', () => {
    const key = Keys.generateFileKey()
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
    expect(key.some((b) => b !== 0)).toBe(true)
  })

  it('wrapFileKeyForFolder round-trips through unwrapFileKeyFromFolder', () => {
    const fileKey = Keys.generateFileKey()
    const folderKey = generateContentKey()
    const fileId = 'test-file-001'

    const envelope = Keys.wrapFileKeyForFolder(fileKey, fileId, folderKey)
    expect(typeof envelope).toBe('string')
    expect(envelope.length).toBeGreaterThan(0)

    const recovered = Keys.unwrapFileKeyFromFolder(envelope, fileId, folderKey)
    expect(recovered).toEqual(fileKey)
  })

  it('unwrapFileKeyFromFolder refuses a wrong subject', () => {
    const fileKey = Keys.generateFileKey()
    const folderKey = generateContentKey()

    const envelope = Keys.wrapFileKeyForFolder(fileKey, 'file-A', folderKey)
    expect(() => Keys.unwrapFileKeyFromFolder(envelope, 'file-B', folderKey)).toThrow()
  })

  it('unwrapFileKeyFromFolder refuses a wrong folder key', () => {
    const fileKey = Keys.generateFileKey()
    const folderKey = generateContentKey()
    const wrongKey = generateContentKey()

    const envelope = Keys.wrapFileKeyForFolder(fileKey, 'file-A', folderKey)
    expect(() => Keys.unwrapFileKeyFromFolder(envelope, 'file-A', wrongKey)).toThrow()
  })
})

describe('Keys: getFileKey fallback chain', () => {
  const fileId = 'test-file-fallback'
  const folderId = 'test-folder-fallback'

  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
    Keys.userPubkey = TEST_PUBKEY
    Keys.wrappedKeyMode = false
    Keys.configure({
      auth: {
        isConnected: true,
        nip04Encrypt: async (_pk: string, pt: string) => `nip04:${pt}`,
        nip04Decrypt: async (_pk: string, ct: string) => ct.replace('nip04:', ''),
        nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
        nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
        createRootKeyEvent: async (ek: string) => ({ kind: 30078, content: ek }),
        publishEvent: async () => {},
      },
      api: null,
    })
  })

  it('falls back to HKDF derivation when no envelope data is provided', async () => {
    const rootKey = await primeKeysWithRoot()
    const folderKey = await deriveFolderKeyManually(rootKey, folderId)

    const derived = await Keys.deriveKey(folderKey, fileId, 'cloistr-drive-file-v1')
    const fromGetFileKey = await Keys.getFileKey(folderId, fileId)

    expect(fromGetFileKey).toEqual(derived)
  })

  it('prefers folder wrapped key over derivation', async () => {
    const rootKey = await primeKeysWithRoot()
    const folderKey = await deriveFolderKeyManually(rootKey, folderId)

    const randomFileKey = Keys.generateFileKey()
    const envelope = Keys.wrapFileKeyForFolder(randomFileKey, fileId, folderKey)

    const result = await Keys.getFileKey(folderId, fileId, {
      folderWrappedKeys: [{ subject: fileId, envelope }],
    })

    expect(result).toEqual(randomFileKey)
    const derived = await Keys.deriveKey(folderKey, fileId, 'cloistr-drive-file-v1')
    expect(result).not.toEqual(derived)
  })

  it('DISCRIMINATION: owner recovers file key after folder event is destroyed', async () => {
    await primeKeysWithRoot()
    const fileKey = Keys.generateFileKey()

    const signer = makeSigner(TEST_PUBKEY)
    const ownerEnvelope = await Keys.wrapFileKeyForOwner(fileKey, fileId, signer)

    // folderId=null simulates destroyed folder: no folder wrapped keys, only owner envelope
    const recovered = await Keys.getFileKey(null, fileId, {
      ownerEnvelope,
      signer,
    })

    expect(recovered).toEqual(fileKey)
  })

  it('DISCRIMINATION: without owner envelope, destroying the folder loses the random key', async () => {
    const rootKey = await primeKeysWithRoot()
    const randomFileKey = Keys.generateFileKey()

    // No owner envelope, no folder wrapped keys, folderId=null → derives root file key
    const result = await Keys.getFileKey(null, fileId)
    // Derivation produces a deterministic key from root, NOT the random key
    expect(result).not.toEqual(randomFileKey)
  })

  it('pre-migration file still opens after migration (same derived key)', async () => {
    const rootKey = await primeKeysWithRoot()
    const folderKey = await deriveFolderKeyManually(rootKey, folderId)

    // Before migration: derive the file key via HKDF
    const derivedBefore = await Keys.deriveKey(folderKey, fileId, 'cloistr-drive-file-v1')

    // Migration wraps the derived key into an envelope
    const envelope = Keys.wrapFileKeyForFolder(derivedBefore, fileId, folderKey)

    // After migration: recover via unwrap
    const recoveredAfter = await Keys.getFileKey(folderId, fileId, {
      folderWrappedKeys: [{ subject: fileId, envelope }],
    })

    expect(recoveredAfter).toEqual(derivedBefore)
  })
})
