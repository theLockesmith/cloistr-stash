// Root key (kind 30078, d=root-key) is replaceable. Publishing a NEW one over
// the user's real key orphans every key derived from it. Found 2026-10-09 in
// the cross-frontend sweep: a new device whose keyring lookup timed out was
// told "no root key" and generated + published one, from sign-in alone.
// Rule: a timeout or error is UNKNOWN, never "none"; nothing is generated or
// published on an unknown answer, and nothing is published over a different key.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys, RootKeyUnavailableError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'

const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
const OTHER = 'b'.repeat(64)

const enc = (key: Uint8Array) => `nip44:${Crypto.bytesToHex(key)}`
const hex = (k: Uint8Array | null | undefined) => (k ? Crypto.bytesToHex(k) : null)

let storage: InMemoryKeyStorage
let publishEvent: ReturnType<typeof vi.fn>
let getKeyring: ReturnType<typeof vi.fn>

function auth(): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(async (ek: string) => ({ kind: 30078, tags: [['d', 'root-key'], ['key', ek]] })),
    publishEvent,
  }
}

const relayTimesOut = () => getKeyring.mockRejectedValue(new Error('Failed to get keyring: 500'))
const relayHas = (k: Uint8Array) => getKeyring.mockResolvedValue({ encrypted_root_key: enc(k) })
const relayHasNone = () => getKeyring.mockResolvedValue({})

beforeEach(async () => {
  await Crypto.init()
  storage = new InMemoryKeyStorage()
  Keys.setStorage(storage)
  publishEvent = vi.fn(async () => {})
  getKeyring = vi.fn()
  Keys.configure({ auth: auth(), api: { getKeyring } })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  Keys.rootKeyRelayAnswer = null
  Keys.rootKeyConflict = false
})

afterEach(() => {
  Keys.clearCache()
  Keys.storage = null
  Keys.api = null
})

describe('a new device with no local root key', () => {
  it('relay does not answer: throws, generates nothing, publishes nothing (the reported bug)', async () => {
    relayTimesOut()
    await Keys.restoreRootKeyFromNostr() // sign-in
    await expect(Keys.getRootKey()).rejects.toBeInstanceOf(RootKeyUnavailableError)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(await storage.get(`${ME}:root`)).toBeFalsy()
  })

  it('relay does not answer: deriving a folder key fails instead of inventing a root', async () => {
    relayTimesOut()
    await expect(Keys.getFolderKey('f-1')).rejects.toBeInstanceOf(RootKeyUnavailableError)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('relay has the key: it is restored, nothing is published', async () => {
    const real = Crypto.generateKey()
    relayHas(real)
    await Keys.restoreRootKeyFromNostr()
    Keys.keyCache.clear()
    expect(hex(await Keys.getRootKey())).toBe(hex(real))
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('relay was slow at sign-in but answers later: the real key is used, not a new one', async () => {
    const real = Crypto.generateKey()
    relayTimesOut()
    await Keys.restoreRootKeyFromNostr()
    relayHas(real)
    expect(hex(await Keys.getRootKey())).toBe(hex(real))
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('relay positively answers none: a root key is generated and published once', async () => {
    relayHasNone()
    const key = await Keys.getRootKey()
    expect(key).toHaveLength(32)
    expect(publishEvent).toHaveBeenCalledOnce()
  })

  it('concurrent first loads on a new device generate ONE key, not one each', async () => {
    relayHasNone()
    const [a, b, c] = await Promise.all([Keys.getRootKey(), Keys.getRootKey(), Keys.getFolderKey('f-1')])
    expect(hex(a)).toBe(hex(b))
    expect(publishEvent).toHaveBeenCalledOnce()
    expect(hex(c)).toBe(hex(await Keys.deriveKey(a, 'f-1', Keys.CONTEXT_FOLDER)))
    expect(Keys.rootKeyConflict).toBe(false)
  })

  it('an answer that arrives after an account switch is not used for the new account', async () => {
    getKeyring.mockImplementation(async () => {
      Keys.userPubkey = OTHER
      return {}
    })
    await expect(Keys.getRootKey()).rejects.toBeInstanceOf(RootKeyUnavailableError)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

describe('a device that has a local root key', () => {
  it('relay does not answer: the local key is used and NOT published (it may differ from the relay copy)', async () => {
    const local = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', local, null)
    relayTimesOut()
    await Keys.restoreRootKeyFromNostr()
    expect(hex(await Keys.getRootKey())).toBe(hex(local))
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('relay holds a DIFFERENT key: neither copy is replaced, and the conflict is flagged', async () => {
    const local = Crypto.generateKey()
    const real = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', local, null)
    relayHas(real)
    await Keys.restoreRootKeyFromNostr()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(Keys.rootKeyConflict).toBe(true)
    expect(Keys.rootKeyLocalOnly).toBe(true) // the warning banner shows
    Keys.keyCache.clear()
    expect(hex(await Keys.loadEncryptedKey('root'))).toBe(hex(local))
  })

  it('relay positively has none: the local key is published (first sync)', async () => {
    await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
    relayHasNone()
    await Keys.restoreRootKeyFromNostr()
    expect(publishEvent).toHaveBeenCalledOnce()
  })
})

describe('publishRootKeyToNostr never writes over a key it has not seen', () => {
  it('refuses when the relay does not answer', async () => {
    relayTimesOut()
    expect(await Keys.publishRootKeyToNostr(Crypto.generateKey())).toBe(false)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(Keys.rootKeyLocalOnly).toBe(true)
  })

  it('refuses when the relay holds a different key', async () => {
    relayHas(Crypto.generateKey())
    expect(await Keys.publishRootKeyToNostr(Crypto.generateKey())).toBe(false)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(Keys.rootKeyConflict).toBe(true)
  })

  it('treats the same key already on the relay as published, without writing again', async () => {
    const k = Crypto.generateKey()
    relayHas(k)
    expect(await Keys.publishRootKeyToNostr(k)).toBe(true)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('the warning banner\'s retry goes through the same check', async () => {
    Keys.keyCache.set('root', Crypto.generateKey())
    relayHas(Crypto.generateKey())
    expect(await Keys.retryPublishRootKey()).toBe(false)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
