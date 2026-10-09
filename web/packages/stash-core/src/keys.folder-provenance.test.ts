// Folder-key provenance (2026-10-09). An incoming folder share used to
// overwrite whatever key the browser held for that folder id, including the
// user's OWN folder key. New uploads into the folder were then wrapped under
// the attacker's key and published in the folder event's public 'wk' tags.
//
// These run on InMemoryKeyStorage, which (like the browser's IndexedDB store)
// does not refuse overwrites: the rule must hold on every store, not only on
// FileKeyStorage.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys, KeyOverwriteRefusedError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'

const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
const ALICE = 'a'.repeat(64)
const MALLORY = 'e'.repeat(64)

let auth: AuthPort
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

const enc = (key: Uint8Array) => `nip44:${Crypto.bytesToHex(key)}`
const hex = (key: Uint8Array | null) => (key ? Crypto.bytesToHex(key) : null)
const stored = async (folderId: string) => {
  Keys.keyCache.clear()
  return hex(await Keys.loadEncryptedKey(`folder:${folderId}`))
}

let storage: InMemoryKeyStorage

beforeEach(async () => {
  await Crypto.init()
  storage = new InMemoryKeyStorage()
  Keys.setStorage(storage)
  auth = mockAuth()
  Keys.configure({ auth })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
})

afterEach(() => {
  Keys.clearCache()
  Keys.storage = null
})

describe('importSharedFolderKey: an incoming share never replaces a key it does not own', () => {
  it('refuses to replace a folder key the user created (the reported attack)', async () => {
    const mine = await Keys.generateFolderKey('f-mine')
    await expect(Keys.importSharedFolderKey('f-mine', enc(Crypto.generateKey()), MALLORY)).rejects.toBeInstanceOf(
      KeyOverwriteRefusedError,
    )
    expect(await stored('f-mine')).toBe(hex(mine))
  })

  it('refuses a share from a different sharer than the one the key came from', async () => {
    const fromAlice = Crypto.generateKey()
    await Keys.importSharedFolderKey('f-alice', enc(fromAlice), ALICE)
    await expect(Keys.importSharedFolderKey('f-alice', enc(Crypto.generateKey()), MALLORY)).rejects.toBeInstanceOf(
      KeyOverwriteRefusedError,
    )
    expect(await stored('f-alice')).toBe(hex(fromAlice))
  })

  it('accepts a first share of a folder it has no key for', async () => {
    const k = Crypto.generateKey()
    await Keys.importSharedFolderKey('f-new', enc(k), ALICE)
    expect(await stored('f-new')).toBe(hex(k))
  })

  it('accepts a rotation from the original sharer (re-share after revoke)', async () => {
    const before = Crypto.generateKey()
    const rotated = Crypto.generateKey()
    await Keys.importSharedFolderKey('f-alice', enc(before), ALICE)
    await Keys.importSharedFolderKey('f-alice', enc(rotated), ALICE)
    expect(await stored('f-alice')).toBe(hex(rotated))
  })

  it('treats re-importing the identical key as a no-op, from anyone', async () => {
    const mine = await Keys.generateFolderKey('f-mine')
    await expect(Keys.importSharedFolderKey('f-mine', enc(mine), MALLORY)).resolves.toBeDefined()
    const rec = await storage.get(`${ME}:folder:f-mine`)
    expect(rec?.sharedBy).toBe(ME) // still marked as our own
  })

  describe('records saved before provenance existed (no sharedBy)', () => {
    const legacy = async (folderId: string, key: Uint8Array) => {
      // Exactly what pre-provenance code wrote: no sharedBy at all.
      await Keys.storeEncryptedKey(`folder:${folderId}`, key, folderId)
    }

    // Residual (c), 2026-10-09: an empty or failed ownership answer is
    // UNKNOWN. Only positive proof that the local key came from this sender
    // lets a share replace it.
    it('refuses with no proof: no checker, a checker that finds nothing, or a checker error', async () => {
      const k = Crypto.generateKey()
      await legacy('f-old', k)
      for (const opts of [
        undefined,
        { existingCameFromSender: async () => false },
        {
          existingCameFromSender: async () => {
            throw new Error('relay timeout')
          },
        },
      ]) {
        await expect(
          Keys.importSharedFolderKey('f-old', enc(Crypto.generateKey()), MALLORY, opts),
        ).rejects.toBeInstanceOf(KeyOverwriteRefusedError)
      }
      expect(await stored('f-old')).toBe(hex(k))
    })

    it('hands the checker the existing local key, so the proof is about that exact key', async () => {
      const k = Crypto.generateKey()
      await legacy('f-old', k)
      const check = vi.fn(async () => false)
      await expect(
        Keys.importSharedFolderKey('f-old', enc(Crypto.generateKey()), ALICE, { existingCameFromSender: check }),
      ).rejects.toBeInstanceOf(KeyOverwriteRefusedError)
      expect(check).toHaveBeenCalledWith(hex(k))
    })

    it('accepts with proof the local key came from this sender, and pins that sharer from then on', async () => {
      await legacy('f-theirs', Crypto.generateKey())
      const rotated = Crypto.generateKey()
      await Keys.importSharedFolderKey('f-theirs', enc(rotated), ALICE, { existingCameFromSender: async () => true })
      expect(await stored('f-theirs')).toBe(hex(rotated))
      expect((await storage.get(`${ME}:folder:f-theirs`))?.sharedBy).toBe(ALICE)
      await expect(
        Keys.importSharedFolderKey('f-theirs', enc(Crypto.generateKey()), MALLORY, {
          existingCameFromSender: async () => true,
        }),
      ).rejects.toBeInstanceOf(KeyOverwriteRefusedError)
    })

    it('a proof never overrides a key we own', async () => {
      const mine = await Keys.generateFolderKey('f-mine')
      await expect(
        Keys.importSharedFolderKey('f-mine', enc(Crypto.generateKey()), MALLORY, {
          existingCameFromSender: async () => true,
        }),
      ).rejects.toBeInstanceOf(KeyOverwriteRefusedError)
      expect(await stored('f-mine')).toBe(hex(mine))
    })
  })
})

describe('resolveOwnFolderKey: the relay copy of an own folder key is authoritative', () => {
  it('repairs a poisoned local key from the folder event\'s key tag', async () => {
    const real = Crypto.generateKey()
    const attacker = Crypto.generateKey()
    // What a pre-fix browser holds after accepting Mallory's share of our folder.
    await Keys.storeEncryptedKey('folder:f-mine', attacker, 'f-mine', { sharedBy: MALLORY })

    const got = await Keys.resolveOwnFolderKey('f-mine', enc(real), null)
    expect(hex(got)).toBe(hex(real))
    expect(await stored('f-mine')).toBe(hex(real))
    expect((await storage.get(`${ME}:folder:f-mine`))?.sharedBy).toBe(ME)
    // and a later share from Mallory is now refused
    await expect(Keys.importSharedFolderKey('f-mine', enc(attacker), MALLORY)).rejects.toBeInstanceOf(
      KeyOverwriteRefusedError,
    )
  })

  it('restores a missing local key from the key tag', async () => {
    const real = Crypto.generateKey()
    expect(hex(await Keys.resolveOwnFolderKey('f-mine', enc(real), null))).toBe(hex(real))
    expect(await stored('f-mine')).toBe(hex(real))
  })

  it('decrypts each tag once: a key already verified against the same tag is not re-decrypted', async () => {
    const real = Crypto.generateKey()
    const tag = enc(real)
    await Keys.resolveOwnFolderKey('f-mine', tag, null)
    const calls = (auth.nip44Decrypt as ReturnType<typeof vi.fn>).mock.calls.length
    Keys.keyCache.clear()
    expect(hex(await Keys.resolveOwnFolderKey('f-mine', tag, null))).toBe(hex(real))
    // Second load: one decrypt (reading the local record), none for the tag.
    // (The mock's ciphertext is deterministic, so count calls, not strings.)
    expect((auth.nip44Decrypt as ReturnType<typeof vi.fn>).mock.calls.length - calls).toBe(1)
  })

  it('with no key tag, drops a key that came from a share and falls back to derivation', async () => {
    const root = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', root, null)
    Keys.keyCache.set('root', root)
    await Keys.storeEncryptedKey('folder:f-legacy', Crypto.generateKey(), 'f-legacy', { sharedBy: MALLORY })

    const derived = await Keys.deriveKey(root, 'f-legacy', Keys.CONTEXT_FOLDER)
    expect(hex(await Keys.resolveOwnFolderKey('f-legacy', undefined, null))).toBe(hex(derived))
  })

  it('with no key tag, keeps an own local key as it is', async () => {
    const mine = await Keys.generateFolderKey('f-x')
    expect(hex(await Keys.resolveOwnFolderKey('f-x', undefined, null))).toBe(hex(mine))
  })

  it('throws (does not fall back to the local key) when the key tag cannot be decrypted', async () => {
    await Keys.storeEncryptedKey('folder:f-mine', Crypto.generateKey(), 'f-mine', { sharedBy: MALLORY })
    await expect(Keys.resolveOwnFolderKey('f-mine', 'garbage', null)).rejects.toThrow()
  })
})

describe('restoreOwnFolderKeys: run on every load, repairs every listed own folder', () => {
  it('repairs a poisoned folder that already has a local key (the old code skipped these)', async () => {
    const real = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-mine', Crypto.generateKey(), 'f-mine', { sharedBy: MALLORY })
    const result = await Keys.restoreOwnFolderKeys([
      { id: 'f-mine', name: 'mine', encrypted_key: enc(real) },
      { id: 'f-untagged', name: 'old' },
    ])
    expect(result.repaired).toBe(1)
    expect(await stored('f-mine')).toBe(hex(real))
  })

  it('counts a failure without stopping the rest', async () => {
    const real = Crypto.generateKey()
    const result = await Keys.restoreOwnFolderKeys([
      { id: 'f-bad', name: 'bad', encrypted_key: 'garbage' },
      { id: 'f-ok', name: 'ok', encrypted_key: enc(real) },
    ])
    expect(result.errors).toBe(1)
    expect(result.restored).toBe(1)
    expect(await stored('f-ok')).toBe(hex(real))
  })
})
