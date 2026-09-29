import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys } from './keys'
import type { AuthPort } from './keys'
import { InMemoryKeyStorage } from './key-storage'

function mockAuth(overrides: Partial<AuthPort> = {}): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
    ...overrides,
  }
}

function disconnectedAuth(): AuthPort {
  return { ...mockAuth(), isConnected: false }
}

describe('storeEncryptedKey refuses plaintext', () => {
  let storage: InMemoryKeyStorage

  beforeEach(() => {
    Keys.nip44Writes = true
    storage = new InMemoryKeyStorage()
    Keys.setStorage(storage)
  })

  afterEach(() => {
    Keys.storage = null
  })

  it('throws when signer is not connected', async () => {
    Keys.configure({ auth: disconnectedAuth() })
    const key = new Uint8Array(32)

    await expect(Keys.storeEncryptedKey('test:1', key, null))
      .rejects.toThrow('signer not connected')
  })

  it('throws when auth is null', async () => {
    Keys.configure({ auth: null })
    const key = new Uint8Array(32)

    await expect(Keys.storeEncryptedKey('test:1', key, null))
      .rejects.toThrow('signer not connected')
  })

  it('encrypts via selfEncrypt when signer is available', async () => {
    const auth = mockAuth()
    Keys.configure({ auth })
    Keys.userPubkey = 'test_pub'

    await Keys.storeEncryptedKey('test:1', new Uint8Array(32), null)

    expect(auth.nip44Encrypt).toHaveBeenCalled()
    const record = await storage.get('test_pub:test:1')
    expect(record).not.toBeNull()
    expect(record!.encryptedKey).toMatch(/^nip44:/)
  })

  it('never writes when signer is disconnected', async () => {
    Keys.configure({ auth: disconnectedAuth() })
    Keys.userPubkey = 'test_pub'

    await expect(Keys.storeEncryptedKey('test:1', new Uint8Array(32), null))
      .rejects.toThrow()

    const record = await storage.get('test_pub:test:1')
    expect(record).toBeNull()
  })
})

describe('loadEncryptedKey returns null when offline', () => {
  beforeEach(() => {
    Keys.setStorage(new InMemoryKeyStorage())
  })

  afterEach(() => {
    Keys.storage = null
  })

  it('returns null when signer is not connected', async () => {
    Keys.configure({ auth: disconnectedAuth() })
    Keys.userPubkey = 'test_pub'

    const result = await Keys.loadEncryptedKey('nonexistent')
    expect(result).toBeNull()
  })
})
