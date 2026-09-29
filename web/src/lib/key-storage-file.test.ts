import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileKeyStorage } from './key-storage-file'
import type { KeyRecord } from './key-storage'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

describe('FileKeyStorage', () => {
  let dir: string
  let storage: FileKeyStorage

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cloistr-keys-test-'))
    storage = new FileKeyStorage(dir)
    await storage.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for a missing key', async () => {
    expect(await storage.get('nonexistent')).toBeNull()
  })

  it('stores and retrieves a record', async () => {
    const record = makeRecord('user:root', 'root')
    await storage.put(record)
    const loaded = await storage.get('user:root')
    expect(loaded).toEqual(record)
  })

  it('persists to disk as JSON', async () => {
    const record = makeRecord('user:root', 'root')
    await storage.put(record)
    const files = await readdir(dir)
    expect(files.length).toBe(1)
    const content = await readFile(join(dir, files[0]), 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed.encryptedKey).toBe('nip44:deadbeef')
  })

  it('files have restrictive permissions', async () => {
    const record = makeRecord('user:root', 'root')
    await storage.put(record)
    const files = await readdir(dir)
    const { statSync } = await import('node:fs')
    const stat = statSync(join(dir, files[0]))
    // 0o100600 = regular file, owner rw only
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('survives a fresh instance pointing at the same dir', async () => {
    const record = makeRecord('user:folder:abc', 'folder:abc')
    await storage.put(record)

    const storage2 = new FileKeyStorage(dir)
    await storage2.init()
    const loaded = await storage2.get('user:folder:abc')
    expect(loaded).toEqual(record)
  })

  it('overwrites an existing record', async () => {
    const r1 = makeRecord('user:root', 'root')
    await storage.put(r1)
    const r2 = { ...r1, encryptedKey: 'nip44:updated' }
    await storage.put(r2)
    const loaded = await storage.get('user:root')
    expect(loaded!.encryptedKey).toBe('nip44:updated')
  })

  it('deletes a record from disk', async () => {
    const record = makeRecord('user:root', 'root')
    await storage.put(record)
    await storage.delete('user:root')
    expect(await storage.get('user:root')).toBeNull()
    const files = await readdir(dir)
    expect(files.length).toBe(0)
  })
})
