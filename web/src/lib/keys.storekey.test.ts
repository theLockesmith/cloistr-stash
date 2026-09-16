import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys } from './keys'
import type { AuthPort } from './keys'

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

function stubDB(): { written: Record<string, unknown>[]; db: IDBDatabase } {
  const written: Record<string, unknown>[] = []
  const db = {
    transaction: () => ({
      objectStore: () => ({
        put: (record: Record<string, unknown>) => {
          written.push(record)
          const req = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
          Promise.resolve().then(() => req.onsuccess?.())
          return req
        },
        get: (_id: string) => {
          const req = {
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null,
            result: undefined as unknown,
          }
          Promise.resolve().then(() => req.onsuccess?.())
          return req
        },
      }),
    }),
  } as unknown as IDBDatabase
  return { written, db }
}

describe('storeEncryptedKey refuses plaintext', () => {
  beforeEach(() => {
    Keys.nip44Writes = true
  })

  afterEach(() => {
    Keys.db = null
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
    const { written, db } = stubDB()
    Keys.db = db

    await Keys.storeEncryptedKey('test:1', new Uint8Array(32), null)

    expect(auth.nip44Encrypt).toHaveBeenCalled()
    expect(written).toHaveLength(1)
    expect(written[0].encryptedKey).toMatch(/^nip44:/)
  })

  it('never writes when signer is disconnected', async () => {
    Keys.configure({ auth: disconnectedAuth() })
    Keys.userPubkey = 'test_pub'
    const { written, db } = stubDB()
    Keys.db = db

    await expect(Keys.storeEncryptedKey('test:1', new Uint8Array(32), null))
      .rejects.toThrow()

    expect(written).toHaveLength(0)
  })
})

describe('loadEncryptedKey returns null when offline', () => {
  afterEach(() => {
    Keys.db = null
  })

  it('returns null when signer is not connected', async () => {
    Keys.configure({ auth: disconnectedAuth() })
    Keys.userPubkey = 'test_pub'
    const { db } = stubDB()
    Keys.db = db

    const result = await Keys.loadEncryptedKey('nonexistent')
    expect(result).toBeNull()
  })
})
