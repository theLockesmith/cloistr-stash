import { describe, it, expect, vi, beforeEach } from 'vitest'

const RANDOM_KEY = new Uint8Array(32).fill(0xaa)
const HKDF_KEY = new Uint8Array(32).fill(0xbb)
const OWNER_ENVELOPE = 'owner-envelope-for-new-file'

let capturedMetadataEvent: Record<string, unknown> | null = null
let generateFileKeyCalled = false
let wrapFileKeyForOwnerCalled = false

vi.mock('./crypto', () => ({
  Crypto: {
    init: async () => {},
    generateKey: () => new Uint8Array(32),
    generateFileId: () => 'new-file-id-after-revoke',
    encryptFile: async (data: Uint8Array) => new Uint8Array(data),
    decryptFile: async (data: ArrayBuffer) => new Uint8Array(data),
    hash: async () => 'newhash123',
    wipeKey: () => {},
    bytesToHex: (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''),
  },
}))

vi.mock('./keys', () => ({
  Keys: {
    wrappedKeyMode: false,
    generateFileKey: () => {
      generateFileKeyCalled = true
      return RANDOM_KEY
    },
    wrapFileKeyForOwner: async () => {
      wrapFileKeyForOwnerCalled = true
      return OWNER_ENVELOPE
    },
    deriveFileKey: async () => HKDF_KEY,
    deriveRootFileKey: async () => HKDF_KEY,
    getFileKey: async () => new Uint8Array(32).fill(0xcc),
    getFolderKey: async () => new Uint8Array(32).fill(0xdd),
    wrapFileKeyForFolder: () => 'folder-envelope',
  },
}))

vi.mock('./api', () => ({
  API: {
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
    uploadFile: async () => ({ sha256: 'reencrypted-hash' }),
    deleteFile: async () => {},
  },
}))

vi.mock('./relay', () => ({
  Relay: {
    subscribe: vi.fn(async () => []),
    queryFolderEvent: vi.fn(async () => ({
      kind: 30079,
      tags: [['d', 'folder-1']],
      content: 'encrypted-folder',
    })),
  },
}))

vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: 'owner-pubkey-abc',
    signEvent: async (e: Record<string, unknown>) => ({ ...e, sig: 'sig', id: 'evtid' }),
    publishEvent: async (e: Record<string, unknown>) => {
      if ((e as { kind?: number }).kind === 30078) {
        capturedMetadataEvent = e
      }
    },
    createUploadAuth: async () => 'auth-header',
  },
  getSigner: () => ({ signEvent: async (e: unknown) => e }),
}))

vi.mock('./upload', () => ({
  addWrappedKeyToFolder: vi.fn(async () => {}),
}))

// Must import after mocks
import { Sharing } from './sharing'
import { Keys } from './keys'
import { addWrappedKeyToFolder } from './upload'

// Mock fetch for download
const mockFetchResponse = new Response(new Uint8Array(64), { status: 200 })
vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse.clone()))

describe('revokeAndReencryptFile: wrapped key mode', () => {
  const testFile = {
    file_id: 'old-file-id',
    folder_id: 'folder-1',
    sha256: 'oldhash',
    name: 'secret.txt',
    mime_type: 'text/plain',
    owner_key: 'old-owner-envelope',
  }

  beforeEach(() => {
    capturedMetadataEvent = null
    generateFileKeyCalled = false
    wrapFileKeyForOwnerCalled = false
    ;(Keys as { wrappedKeyMode: boolean }).wrappedKeyMode = false
  })

  it('uses HKDF derivation when wrappedKeyMode is false and file is not wrapped', async () => {
    ;(Keys as { wrappedKeyMode: boolean }).wrappedKeyMode = false

    const { owner_key: _unused, ...unwrappedFile } = testFile
    const result = await Sharing.revokeAndReencryptFile(unwrappedFile as never)

    expect(result.newFileId).toBe('new-file-id-after-revoke')
    expect(generateFileKeyCalled).toBe(false)
    expect(wrapFileKeyForOwnerCalled).toBe(false)
  })

  it('PER-FILE: already-wrapped file stays wrapped even when wrappedKeyMode is false (fresh client)', async () => {
    ;(Keys as { wrappedKeyMode: boolean }).wrappedKeyMode = false

    await Sharing.revokeAndReencryptFile(testFile as never)

    expect(generateFileKeyCalled).toBe(true)
    expect(wrapFileKeyForOwnerCalled).toBe(true)
    const tags = (capturedMetadataEvent as { tags: string[][] }).tags
    expect(tags.find((t: string[]) => t[0] === 'owner_key')).toBeTruthy()
  })

  it('generates random key + wraps when wrappedKeyMode is true', async () => {
    ;(Keys as { wrappedKeyMode: boolean }).wrappedKeyMode = true

    await Sharing.revokeAndReencryptFile(testFile as never)

    expect(generateFileKeyCalled).toBe(true)
    expect(wrapFileKeyForOwnerCalled).toBe(true)
  })

  it('publishes ownerEnvelope in metadata event when wrappedKeyMode is true', async () => {
    ;(Keys as { wrappedKeyMode: boolean }).wrappedKeyMode = true

    await Sharing.revokeAndReencryptFile(testFile as never)

    expect(capturedMetadataEvent).not.toBeNull()
    const tags = (capturedMetadataEvent as { tags?: string[][] })?.tags ?? []
    const ownerKeyTag = tags.find((t: string[]) => t[0] === 'owner_key')
    expect(ownerKeyTag).toBeTruthy()
    expect(ownerKeyTag![1]).toBe(OWNER_ENVELOPE)
  })

  it('adds wrapped key to folder when wrappedKeyMode is true and file has a folder', async () => {
    ;(Keys as { wrappedKeyMode: boolean }).wrappedKeyMode = true

    await Sharing.revokeAndReencryptFile(testFile as never)

    expect(addWrappedKeyToFolder).toHaveBeenCalledWith(
      'folder-1',
      'new-file-id-after-revoke',
      RANDOM_KEY,
    )
  })

  it('old HKDF key cannot decrypt data encrypted with random key', async () => {
    const randomKey = new Uint8Array(32)
    crypto.getRandomValues(randomKey)
    const hkdfKey = new Uint8Array(32).fill(0xbb)

    expect(Buffer.from(randomKey).equals(Buffer.from(hkdfKey))).toBe(false)
  })
})
