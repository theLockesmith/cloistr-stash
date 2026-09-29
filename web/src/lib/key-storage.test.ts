import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryKeyStorage, type KeyRecord } from './key-storage'

function makeRecord(id: string, keyId: string): KeyRecord {
  return {
    id,
    pubkey: 'test-pubkey',
    keyId,
    type: keyId.split(':')[0],
    associatedId: null,
    encryptedKey: 'nip44:deadbeef',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('InMemoryKeyStorage', () => {
  let storage: InMemoryKeyStorage

  beforeEach(async () => {
    storage = new InMemoryKeyStorage()
    await storage.init()
  })

  it('returns null for a missing key', async () => {
    const result = await storage.get('nonexistent')
    expect(result).toBeNull()
  })

  it('stores and retrieves a record', async () => {
    const record = makeRecord('user:root', 'root')
    await storage.put(record)
    const loaded = await storage.get('user:root')
    expect(loaded).toEqual(record)
  })

  it('does not share references with the caller', async () => {
    const record = makeRecord('user:root', 'root')
    await storage.put(record)
    record.encryptedKey = 'mutated'
    const loaded = await storage.get('user:root')
    expect(loaded!.encryptedKey).toBe('nip44:deadbeef')
  })

  it('overwrites an existing record', async () => {
    const r1 = makeRecord('user:root', 'root')
    await storage.put(r1)
    const r2 = { ...r1, encryptedKey: 'nip44:updated' }
    await storage.put(r2)
    const loaded = await storage.get('user:root')
    expect(loaded!.encryptedKey).toBe('nip44:updated')
  })

  it('deletes a record', async () => {
    const record = makeRecord('user:folder:abc', 'folder:abc')
    await storage.put(record)
    await storage.delete('user:folder:abc')
    const loaded = await storage.get('user:folder:abc')
    expect(loaded).toBeNull()
  })

  it('delete on missing key is a no-op', async () => {
    await expect(storage.delete('nonexistent')).resolves.toBeUndefined()
  })
})
