// Folder-key provenance, residuals (2026-10-09 follow-up to the share fix):
//  (a) a backup file goes through the same admission rule as a share;
//  (b) repairing a parent re-derives the subfolders derived from the bad key;
//  (d) an untagged own folder whose pre-provenance key is not the derived key
//      is reported unverified and refused for new files, never silently used.
// (c), unknown ownership refuses, is in keys.folder-provenance.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys, KeyOverwriteRefusedError, FolderKeyUnverifiedError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'

const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
const ALICE = 'a'.repeat(64)
const MALLORY = 'e'.repeat(64)

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
const stored = async (keyId: string) => {
  Keys.keyCache.clear()
  return hex(await Keys.loadEncryptedKey(keyId))
}
const derive = (k: Uint8Array, id: string) => Keys.deriveKey(k, id, Keys.CONTEXT_FOLDER)

let storage: InMemoryKeyStorage
let root: Uint8Array

beforeEach(async () => {
  await Crypto.init()
  storage = new InMemoryKeyStorage()
  Keys.setStorage(storage)
  Keys.configure({ auth: mockAuth() })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  Keys.unverifiedFolders?.clear()
  root = Crypto.generateKey()
  await Keys.storeEncryptedKey('root', root, null)
})

afterEach(() => {
  Keys.clearCache()
  Keys.storage = null
})

/** A backup file exactly as exportBackup writes it (self-encrypted JSON). */
async function backupFile(keys: Array<{ keyId: string; key: Uint8Array; sharedBy?: string }>) {
  const json = JSON.stringify({
    version: 1,
    createdAt: 1,
    pubkey: ME,
    keys: keys.map((k) => ({
      keyId: k.keyId,
      type: k.keyId.split(':')[0],
      associatedId: k.keyId.includes(':') ? k.keyId.split(':')[1] : null,
      encryptedKey: enc(k.key),
      ...(k.sharedBy ? { sharedBy: k.sharedBy } : {}),
    })),
  })
  return { encrypted: `nip44:${json}`, hash: await Crypto.hash(new TextEncoder().encode(json)), pubkey: ME }
}

describe('(a) importBackup goes through the folder-key admission rule', () => {
  it('never replaces an existing folder key with different bytes', async () => {
    // a copy: importBackup clears (and wipes) the key cache
    const mine = new Uint8Array(await Keys.generateFolderKey('f-mine'))
    const result = await Keys.importBackup(await backupFile([{ keyId: 'folder:f-mine', key: Crypto.generateKey() }]))
    expect(result).toMatchObject({ imported: 0, refused: 1 })
    expect(await stored('folder:f-mine')).toBe(hex(mine))
  })

  it('does not let a backup entry claim a key is ours: it is stored without provenance, and the relay copy then repairs it', async () => {
    const planted = Crypto.generateKey()
    const real = Crypto.generateKey()
    await Keys.importBackup(await backupFile([{ keyId: 'folder:f-mine', key: planted, sharedBy: ME }]))
    expect((await storage.get(`${ME}:folder:f-mine`))?.sharedBy).toBeUndefined()

    const result = await Keys.restoreOwnFolderKeys([{ id: 'f-mine', encrypted_key: enc(real) }])
    expect(result.repaired).toBe(1)
    expect(await stored('folder:f-mine')).toBe(hex(real))
  })

  it('a backup cannot plant a key on an untagged own folder: it is reported unverified, not used for new files', async () => {
    await Keys.importBackup(await backupFile([{ keyId: 'folder:f-old', key: Crypto.generateKey() }]))
    const result = await Keys.restoreOwnFolderKeys([{ id: 'f-old' }])
    expect(result.unverified).toEqual(['f-old'])
    expect(() => Keys.assertFolderKeyUsable('f-old')).toThrow(FolderKeyUnverifiedError)
  })

  it('a shared-in key from a backup keeps its sharer, so a later share from someone else is refused', async () => {
    const fromAlice = Crypto.generateKey()
    await Keys.importBackup(await backupFile([{ keyId: 'folder:f-alice', key: fromAlice, sharedBy: ALICE }]))
    expect((await storage.get(`${ME}:folder:f-alice`))?.sharedBy).toBe(ALICE)
    await expect(Keys.importSharedFolderKey('f-alice', enc(Crypto.generateKey()), MALLORY)).rejects.toBeInstanceOf(
      KeyOverwriteRefusedError,
    )
  })

  it('never replaces the root key (or any other key) with different bytes', async () => {
    const result = await Keys.importBackup(await backupFile([{ keyId: 'root', key: Crypto.generateKey() }]))
    expect(result.refused).toBe(1)
    expect(await stored('root')).toBe(hex(root))
  })

  it('still restores the keys this device is missing (the backup\'s purpose)', async () => {
    await storage.delete(`${ME}:root`)
    const folderKey = Crypto.generateKey()
    const result = await Keys.importBackup(
      await backupFile([
        { keyId: 'root', key: root },
        { keyId: 'folder:f-new', key: folderKey },
      ]),
    )
    expect(result).toMatchObject({ imported: 2, total: 2, refused: 0 })
    expect(await stored('root')).toBe(hex(root))
    expect(await stored('folder:f-new')).toBe(hex(folderKey))
  })

  it('re-importing the same keys is a no-op, not a refusal', async () => {
    const mine = await Keys.generateFolderKey('f-mine')
    const result = await Keys.importBackup(await backupFile([{ keyId: 'folder:f-mine', key: mine }]))
    expect(result).toMatchObject({ imported: 1, refused: 0 })
    expect((await storage.get(`${ME}:folder:f-mine`))?.sharedBy).toBe(ME)
  })
})

describe('(b) repairing a parent re-derives the subfolders derived from the bad key', () => {
  it('re-derives a child and grandchild whose keys came from the poisoned parent, whatever the list order', async () => {
    const real = Crypto.generateKey()
    const attacker = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:p', attacker, 'p', { sharedBy: MALLORY })
    // What getFolderKey stored while the parent was poisoned (pre-provenance records).
    const badChild = await derive(attacker, 'c')
    const badGrand = await derive(badChild, 'g')
    await Keys.storeEncryptedKey('folder:c', badChild, 'c')
    await Keys.storeEncryptedKey('folder:g', badGrand, 'g')

    const result = await Keys.restoreOwnFolderKeys([
      { id: 'g', parent_id: 'c' },
      { id: 'c', parent_id: 'p' },
      { id: 'p', encrypted_key: enc(real) },
    ])

    const goodChild = await derive(real, 'c')
    expect(await stored('folder:p')).toBe(hex(real))
    expect(await stored('folder:c')).toBe(hex(goodChild))
    expect(await stored('folder:g')).toBe(hex(await derive(goodChild, 'g')))
    expect(result).toMatchObject({ repaired: 3, unverified: [] })
  })

  it('also re-derives children when the repair was dropping a shared-in key from an untagged parent', async () => {
    const attacker = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:p', attacker, 'p', { sharedBy: MALLORY })
    await Keys.storeEncryptedKey('folder:c', await derive(attacker, 'c'), 'c')

    await Keys.restoreOwnFolderKeys([{ id: 'p' }, { id: 'c', parent_id: 'p' }])

    const goodParent = await derive(root, 'p')
    expect(await stored('folder:p')).toBe(hex(goodParent))
    expect(await stored('folder:c')).toBe(hex(await derive(goodParent, 'c')))
  })

  it('leaves a child alone when its key was not derived from the replaced key', async () => {
    const real = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:p', Crypto.generateKey(), 'p', { sharedBy: MALLORY })
    const own = await Keys.generateFolderKey('c') // tagged child: its own tag is authoritative
    const loose = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:u', loose, 'u') // untagged, not derived from anything we know

    await Keys.restoreOwnFolderKeys([
      { id: 'p', encrypted_key: enc(real) },
      { id: 'c', parent_id: 'p', encrypted_key: enc(own) },
      { id: 'u', parent_id: 'p' },
    ])
    expect(await stored('folder:c')).toBe(hex(own))
    expect(await stored('folder:u')).toBe(hex(loose))
    // kept, but not the derivation from the real parent: unverified, not silently used
    expect(() => Keys.assertFolderKeyUsable('u')).toThrow(FolderKeyUnverifiedError)
  })
})

describe('(d) untagged own folder with a pre-provenance key that is not the derived key', () => {
  it('a pre-provenance key equal to the derived key is confirmed as ours (once), not flagged', async () => {
    const derived = await derive(root, 'f-old')
    await Keys.storeEncryptedKey('folder:f-old', derived, 'f-old')
    const result = await Keys.restoreOwnFolderKeys([{ id: 'f-old' }])
    expect(result.unverified).toEqual([])
    expect((await storage.get(`${ME}:folder:f-old`))?.sharedBy).toBe(ME)
    expect(() => Keys.assertFolderKeyUsable('f-old')).not.toThrow()
  })

  it('a pre-provenance key that is NOT the derived key is reported, refused for writes, and kept for reads', async () => {
    const odd = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-old', odd, 'f-old')

    const result = await Keys.restoreOwnFolderKeys([{ id: 'f-old' }])
    expect(result.unverified).toEqual(['f-old'])
    expect(() => Keys.assertFolderKeyUsable('f-old')).toThrow(FolderKeyUnverifiedError)
    await expect(Keys.resolveOwnFolderKey('f-old', undefined, null)).rejects.toBeInstanceOf(FolderKeyUnverifiedError)
    // nothing was destroyed: existing files still open with the local key
    expect(await stored('folder:f-old')).toBe(hex(odd))
    expect(hex(await Keys.getFolderKey('f-old'))).toBe(hex(odd))
  })

  it('subfolders under an unverified folder are unverified too, stored key or not, and uploads into them are refused', async () => {
    const odd = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:p', odd, 'p')
    await Keys.storeEncryptedKey('folder:c', await derive(odd, 'c'), 'c')
    const result = await Keys.restoreOwnFolderKeys([
      { id: 'g', parent_id: 'c' }, // no local key yet: would be derived from the unverified chain
      { id: 'c', parent_id: 'p' },
      { id: 'p' },
    ])
    expect(result.unverified.sort()).toEqual(['c', 'g', 'p'])
    for (const id of ['p', 'c', 'g']) expect(() => Keys.assertFolderKeyUsable(id)).toThrow(FolderKeyUnverifiedError)
    await expect(Keys.resolveOwnFolderKey('c', undefined, 'p')).rejects.toBeInstanceOf(FolderKeyUnverifiedError)
    expect((await storage.get(`${ME}:folder:c`))?.sharedBy).toBeUndefined()
  })

  it('a flag clears on the next load once its cause is gone', async () => {
    const odd = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:p', odd, 'p')
    await Keys.restoreOwnFolderKeys([{ id: 'p' }, { id: 'c', parent_id: 'p' }])
    expect(() => Keys.assertFolderKeyUsable('c')).toThrow(FolderKeyUnverifiedError)
    // the parent's real key turns up (its tag is published); the child follows
    const real = Crypto.generateKey()
    await Keys.restoreOwnFolderKeys([{ id: 'p', encrypted_key: enc(real) }, { id: 'c', parent_id: 'p' }])
    expect(() => Keys.assertFolderKeyUsable('p')).not.toThrow()
    expect(() => Keys.assertFolderKeyUsable('c')).not.toThrow()
  })

  it('checking a subfolder never invents a key for a parent this device does not hold', async () => {
    await Keys.storeEncryptedKey('folder:c', Crypto.generateKey(), 'c')
    await Keys.resolveOwnFolderKeyStatus('c', undefined, 'p')
    expect(await storage.get(`${ME}:folder:p`)).toBeFalsy()
  })

  it('a key tag appearing later clears the flag', async () => {
    const real = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-old', Crypto.generateKey(), 'f-old')
    await Keys.restoreOwnFolderKeys([{ id: 'f-old' }])
    await Keys.restoreOwnFolderKeys([{ id: 'f-old', encrypted_key: enc(real) }])
    expect(() => Keys.assertFolderKeyUsable('f-old')).not.toThrow()
    expect(await stored('folder:f-old')).toBe(hex(real))
  })
})
