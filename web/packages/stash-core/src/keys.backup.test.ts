// Key backup (STASH-30, found live 2026-10-19): Download Backup failed with
// "Backup requires browser storage" for every user. exportBackup, and the
// other whole-store reads, still went through Keys.db, which nothing has set
// since key records moved behind the KeyStorage adapter. They now list
// records through the adapter.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Keys } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { IndexedDBKeyStorage, InMemoryKeyStorage, type KeyStorage } from './key-storage'

const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
const OTHER = 'b'.repeat(64)

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

const hex = (key: Uint8Array | null) => (key ? Crypto.bytesToHex(key) : null)

let dbCounter = 0
const backends: Array<[string, () => KeyStorage]> = [
  ['IndexedDB (the browser app)', () => new IndexedDBKeyStorage(`keys-backup-test-${++dbCounter}`, 1, 'keys')],
  ['in memory', () => new InMemoryKeyStorage()],
]

describe.each(backends)('key backup on %s storage', (_name, make) => {
  let storage: KeyStorage

  beforeEach(async () => {
    await Crypto.init()
    storage = make()
    Keys.setStorage(storage)
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = ME
    Keys.nip44Writes = true
    Keys.keyCache.clear()
  })

  afterEach(() => {
    Keys.clearCache()
    Keys.storage = null
  })

  it('exports a backup holding every key of this user, and only this user', async () => {
    const root = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', root, null)
    await Keys.generateFolderKey('f1')
    await storage.put({
      id: `${OTHER}:root`, pubkey: OTHER, keyId: 'root', type: 'root', associatedId: null,
      encryptedKey: 'nip44:00', createdAt: 1, updatedAt: 1,
    })

    const backup = await Keys.exportBackup()

    expect(backup.pubkey).toBe(ME)
    const inside = JSON.parse(backup.encrypted.replace('nip44:', '')) as { keys: Array<{ keyId: string }> }
    expect(inside.keys.map((k) => k.keyId).sort()).toEqual(['folder:f1', 'root'])
  })

  it('a backup restores the keys on a device that lost them', async () => {
    const root = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', root, null)
    const folder = new Uint8Array(await Keys.generateFolderKey('f1'))
    const backup = await Keys.exportBackup()

    // a fresh device: empty storage
    Keys.clearCache()
    Keys.setStorage(make())
    Keys.configure({ auth: mockAuth() })
    Keys.userPubkey = ME
    const result = await Keys.importBackup(backup)

    expect(result).toMatchObject({ imported: 2, total: 2, refused: 0 })
    Keys.keyCache.clear()
    expect(hex(await Keys.loadEncryptedKey('root'))).toBe(hex(root))
    expect(hex(await Keys.loadEncryptedKey('folder:f1'))).toBe(hex(folder))
  })

  it('getAllFolderIds lists the stored folder keys, not just the cached ones', async () => {
    await Keys.generateFolderKey('f1')
    await Keys.generateFolderKey('f2')
    Keys.keyCache.clear()
    expect((await Keys.getAllFolderIds()).sort()).toEqual(['f1', 'f2'])
  })

  it('clearAllKeys removes this user\'s stored keys and leaves other users\' alone', async () => {
    await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
    await storage.put({
      id: `${OTHER}:root`, pubkey: OTHER, keyId: 'root', type: 'root', associatedId: null,
      encryptedKey: 'nip44:00', createdAt: 1, updatedAt: 1,
    })
    await Keys.clearAllKeys()
    expect(await storage.get(`${ME}:root`)).toBeNull()
    expect(await storage.get(`${OTHER}:root`)).not.toBeNull()
  })
})
