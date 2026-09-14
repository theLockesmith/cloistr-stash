/**
 * Tests for the root-key publish resilience changes.
 *
 * Forces the failure path (relay refuses the publish) and verifies:
 *   1. rootKeyLocalOnly flag gets set on both callers (generateRootKey, migration)
 *   2. rootKeyLocalOnly clears when the relay accepts
 *   3. retryPublishRootKey re-attempts and clears the flag on success
 *   4. The listener mechanism fires on state changes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keys, type AuthPort } from './keys'
import { Crypto } from './crypto'

function makeAuthStub(overrides: Partial<AuthPort> = {}): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: async (_pk: string, pt: string) => `enc:${pt}`,
    nip04Decrypt: async (_pk: string, ct: string) => ct.replace('enc:', ''),
    createRootKeyEvent: async (ek: string) => ({ kind: 30078, content: ek }),
    publishEvent: async () => {},
    ...overrides,
  }
}

function stubStorage() {
  const store = new Map<string, unknown>()
  Keys.db = { objectStoreNames: { contains: () => true } } as unknown as IDBDatabase
  ;(Keys as Record<string, unknown>).storeEncryptedKey = async (id: string, key: Uint8Array) => {
    store.set(id, key)
  }
  ;(Keys as Record<string, unknown>).loadEncryptedKey = async (id: string) => {
    return store.get(id) as Uint8Array | undefined ?? null
  }
  return store
}

beforeEach(() => {
  Keys.keyCache.clear()
  Keys.rootKeyLocalOnly = false
  Keys.lastPublishError = null
  Keys._localOnlyListeners.clear()
  Keys.userPubkey = 'aa'.repeat(32)
  Keys.nip44Writes = false
  Keys.api = null
  stubStorage()
  // Stub Crypto.generateKey so generateRootKey tests don't need libsodium.
  ;(Crypto as Record<string, unknown>).generateKey = () => {
    const key = new Uint8Array(32)
    globalThis.crypto.getRandomValues(key)
    return key
  }
  ;(Crypto as Record<string, unknown>).bytesToHex = (bytes: Uint8Array) =>
    Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
})

describe('publishRootKeyToNostr', () => {
  it('returns true and clears rootKeyLocalOnly when the relay accepts', async () => {
    Keys.configure({ auth: makeAuthStub() })
    Keys.rootKeyLocalOnly = true

    const key = new Uint8Array(32).fill(0x42)
    const result = await Keys.publishRootKeyToNostr(key)

    expect(result).toBe(true)
    expect(Keys.rootKeyLocalOnly).toBe(false)
  })

  it('returns false and sets rootKeyLocalOnly when publishEvent throws', async () => {
    Keys.configure({
      auth: makeAuthStub({
        publishEvent: async () => { throw new Error('restricted: rate limit exceeded') },
      }),
    })

    const key = new Uint8Array(32).fill(0x42)
    const result = await Keys.publishRootKeyToNostr(key)

    expect(result).toBe(false)
    expect(Keys.rootKeyLocalOnly).toBe(true)
  })

  it('returns false when auth is not connected', async () => {
    Keys.configure({
      auth: makeAuthStub({ isConnected: false } as unknown as AuthPort),
    })

    const key = new Uint8Array(32).fill(0x42)
    const result = await Keys.publishRootKeyToNostr(key)

    expect(result).toBe(false)
  })

  it('returns false when auth is null', async () => {
    Keys.configure({ auth: null })

    const key = new Uint8Array(32).fill(0x42)
    const result = await Keys.publishRootKeyToNostr(key)

    expect(result).toBe(false)
  })

  it('stores the error message in lastPublishError on failure', async () => {
    Keys.configure({
      auth: makeAuthStub({
        publishEvent: async () => { throw new Error('auth-required: complete NIP-42 first') },
      }),
    })

    const key = new Uint8Array(32).fill(0x42)
    await Keys.publishRootKeyToNostr(key)

    expect(Keys.lastPublishError).toBe('auth-required: complete NIP-42 first')
  })

  it('clears lastPublishError on success', async () => {
    Keys.configure({ auth: makeAuthStub() })
    Keys.lastPublishError = 'previous failure'

    const key = new Uint8Array(32).fill(0x42)
    await Keys.publishRootKeyToNostr(key)

    expect(Keys.lastPublishError).toBeNull()
  })
})

describe('generateRootKey', () => {
  it('sets rootKeyLocalOnly when the publish fails', async () => {
    Keys.configure({
      auth: makeAuthStub({
        publishEvent: async () => { throw new Error('relay refused') },
      }),
    })

    const key = await Keys.generateRootKey()

    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
    expect(Keys.rootKeyLocalOnly).toBe(true)
    expect(Keys.keyCache.get('root')).toBe(key)
  })

  it('clears rootKeyLocalOnly when the publish succeeds', async () => {
    Keys.configure({ auth: makeAuthStub() })
    Keys.rootKeyLocalOnly = true

    await Keys.generateRootKey()

    expect(Keys.rootKeyLocalOnly).toBe(false)
  })
})

describe('restoreRootKeyFromNostr (migration path)', () => {
  it('sets rootKeyLocalOnly when migrating a local key fails to publish', async () => {
    const store = stubStorage()
    const localKey = new Uint8Array(32).fill(0xAA)
    store.set('root', localKey)

    Keys.configure({
      auth: makeAuthStub({
        publishEvent: async () => { throw new Error('restricted: pubkey not on whitelist') },
      }),
      api: { getKeyring: async () => ({ encrypted_root_key: undefined }) },
    })

    await Keys.restoreRootKeyFromNostr()

    expect(Keys.rootKeyLocalOnly).toBe(true)
    expect(Keys.keyCache.get('root')).toBe(localKey)
  })

  it('clears rootKeyLocalOnly when both local and Nostr keys exist', async () => {
    const store = stubStorage()
    const localKey = new Uint8Array(32).fill(0xBB)
    store.set('root', localKey)

    Keys.rootKeyLocalOnly = true
    Keys.configure({
      auth: makeAuthStub(),
      api: { getKeyring: async () => ({ encrypted_root_key: 'enc:bb'.repeat(16) }) },
    })

    await Keys.restoreRootKeyFromNostr()

    expect(Keys.rootKeyLocalOnly).toBe(false)
  })
})

describe('retryPublishRootKey', () => {
  it('republishes from cache and clears rootKeyLocalOnly on success', async () => {
    const publishSpy = vi.fn().mockResolvedValue(undefined)
    Keys.configure({ auth: makeAuthStub({ publishEvent: publishSpy }) })

    const key = new Uint8Array(32).fill(0xCC)
    Keys.keyCache.set('root', key)
    Keys.rootKeyLocalOnly = true

    const result = await Keys.retryPublishRootKey()

    expect(result).toBe(true)
    expect(Keys.rootKeyLocalOnly).toBe(false)
    expect(publishSpy).toHaveBeenCalledOnce()
  })

  it('reloads from storage when cache is empty', async () => {
    const store = stubStorage()
    const key = new Uint8Array(32).fill(0xDD)
    store.set('root', key)

    const publishSpy = vi.fn().mockResolvedValue(undefined)
    Keys.configure({ auth: makeAuthStub({ publishEvent: publishSpy }) })
    Keys.rootKeyLocalOnly = true
    Keys.keyCache.clear()

    const result = await Keys.retryPublishRootKey()

    expect(result).toBe(true)
    expect(Keys.rootKeyLocalOnly).toBe(false)
    expect(publishSpy).toHaveBeenCalledOnce()
  })

  it('returns false when no key exists anywhere', async () => {
    stubStorage()
    Keys.configure({ auth: makeAuthStub() })
    Keys.keyCache.clear()

    const result = await Keys.retryPublishRootKey()

    expect(result).toBe(false)
  })

  it('leaves rootKeyLocalOnly true when retry also fails', async () => {
    Keys.configure({
      auth: makeAuthStub({
        publishEvent: async () => { throw new Error('still refused') },
      }),
    })

    const key = new Uint8Array(32).fill(0xEE)
    Keys.keyCache.set('root', key)
    Keys.rootKeyLocalOnly = true

    const result = await Keys.retryPublishRootKey()

    expect(result).toBe(false)
    expect(Keys.rootKeyLocalOnly).toBe(true)
  })
})

describe('rootKeyLocalOnly listener mechanism', () => {
  it('fires listeners when the flag changes', () => {
    const listener = vi.fn()
    Keys.onRootKeyLocalOnlyChange(listener)

    Keys._setRootKeyLocalOnly(true)
    expect(listener).toHaveBeenCalledWith(true)

    Keys._setRootKeyLocalOnly(false)
    expect(listener).toHaveBeenCalledWith(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not fire when the value does not change', () => {
    const listener = vi.fn()
    Keys.onRootKeyLocalOnlyChange(listener)

    Keys._setRootKeyLocalOnly(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribe function removes the listener', () => {
    const listener = vi.fn()
    const unsub = Keys.onRootKeyLocalOnlyChange(listener)

    unsub()
    Keys._setRootKeyLocalOnly(true)

    expect(listener).not.toHaveBeenCalled()
  })

  it('a throwing listener does not break other listeners', () => {
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()

    Keys.onRootKeyLocalOnlyChange(bad)
    Keys.onRootKeyLocalOnlyChange(good)

    Keys._setRootKeyLocalOnly(true)

    expect(bad).toHaveBeenCalled()
    expect(good).toHaveBeenCalled()
  })
})
