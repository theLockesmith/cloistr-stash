// @vitest-environment jsdom
// The required test from architecture/key-model.md, "Migrating Stash: phase 1":
// a file encrypted before the migration still opens after it, and a file whose
// folder event was destroyed still opens for the owner. Real XChaCha20 and the
// real migration, so a wrong or missing key genuinely fails to decrypt.
//
// Discriminations: the migration re-uploads nothing (same blobs, same hashes),
// and the same file WITHOUT its owner envelope does not open once the folder
// event and every derivable key are gone, so the envelope is what saves it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Ev = { kind: number; created_at: number; tags: string[][]; content: string }
const { ME, relayEvents } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  relayEvents: {} as Record<string, Ev>,
}))

vi.mock('./relay', () => ({
  Relay: {
    subscribe: vi.fn(async (f: { kinds: number[]; '#d'?: string[] }) => {
      const d = f['#d']?.[0] ?? ''
      return relayEvents[d] ? [relayEvents[d]] : []
    }),
  },
}))

vi.mock('./api', () => ({
  API: {
    listFolders: vi.fn(),
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
    getDownloadURL: (sha: string) => `blob:${sha}`,
  },
}))

vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    signEvent: async (e: Ev) => ({ ...e, pubkey: ME, id: 'id', sig: 'sig' }),
    // The relay is replaceable by d tag: a publish overwrites what it holds.
    publishEvent: async (e: Ev) => {
      const d = e.tags.find((t) => t[0] === 'd')?.[1]
      if (d) relayEvents[d] = e
    },
  },
  getSigner: () => ({
    getPublicKey: async () => ME,
    nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
    nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
  }),
}))

import { Keys } from './keys'
import { Crypto } from './crypto'
import { API } from './api'
import { InMemoryKeyStorage } from './key-storage'
import { runWrappedKeyMigration } from './migration-wrapped-keys'
import { readFileBytes } from './fileKey'

const PLAINTEXT = 'written before the migration'
const blobs = new Map<string, Uint8Array>()
const text = (b: Uint8Array) => new TextDecoder().decode(b)

// Rows as listFiles returns them, before the migration: no owner_key.
const inFolder = { id: 'file-old', sha256: '', encrypted: true, folder_id: 'folder-1', name: 'old.txt' }
const atRoot = { id: 'file-root', sha256: '', encrypted: true, name: 'root.txt' }

/** The file's row after the migration: its current relay event's owner_key. */
function migrated<T extends { id: string }>(row: T): T & { owner_key: string } {
  const ownerKey = relayEvents[row.id]?.tags.find((t) => t[0] === 'owner_key')?.[1]
  expect(ownerKey, `${row.id} has an owner envelope`).toBeTruthy()
  return { ...row, owner_key: ownerKey! }
}

/** Forget every key the old scheme could derive from: root, folder, cached file keys. */
function loseDerivableKeys() {
  Keys.keyCache.clear()
  Keys.setStorage(new InMemoryKeyStorage())
}

async function encryptUnder(key: Uint8Array): Promise<string> {
  const data = await Crypto.encryptFile(new TextEncoder().encode(PLAINTEXT), key)
  const u8 = data instanceof Uint8Array ? data.slice() : new Uint8Array(data as ArrayBuffer)
  const sha = await Crypto.hash(u8)
  blobs.set(sha, u8)
  return sha
}

beforeEach(async () => {
  await Crypto.init()
  for (const k of Object.keys(relayEvents)) delete relayEvents[k]
  blobs.clear()
  localStorage.clear()
  Keys.keyCache.clear()
  Keys.setStorage(new InMemoryKeyStorage())
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.wrappedKeyMode = false
  Keys.configure({
    auth: {
      isConnected: true,
      nip04Encrypt: async (_pk: string, pt: string) => `nip04:${pt}`,
      nip04Decrypt: async (_pk: string, ct: string) => ct.replace('nip04:', ''),
      nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
      nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
      createRootKeyEvent: async (ek: string) => ({ kind: 30078, content: ek }),
      publishEvent: async () => {},
    },
    api: null,
  })
  const rootKey = Crypto.generateKey()
  Keys.keyCache.set('root', rootKey)
  Keys.keyCache.set('folder:folder-1', await Keys.deriveKey(rootKey, 'folder-1', Keys.CONTEXT_FOLDER))

  // Old-scheme files: encrypted under keys nobody stored, only derivable.
  inFolder.sha256 = await encryptUnder(await Keys.deriveFileKey('folder-1', 'file-old'))
  atRoot.sha256 = await encryptUnder(await Keys.deriveRootFileKey('file-root'))
  relayEvents['folder-1'] = {
    kind: 30079, created_at: 1,
    tags: [['d', 'folder-1'], ['encrypted', 'true']],
    content: JSON.stringify({ name: 'docs', encrypted: true }),
  }
  for (const row of [inFolder, atRoot]) {
    relayEvents[row.id] = {
      kind: 30078, created_at: 1,
      tags: [['d', row.id], ['x', row.sha256], ['encrypted', 'xchacha20-poly1305'], ...('folder_id' in row ? [['folder', row.folder_id]] : [])],
      content: JSON.stringify({ name: row.name }),
    }
  }

  vi.mocked(API.listFolders).mockResolvedValue({ folders: [{ id: 'folder-1', name: 'docs', parent_id: null }] } as never)
  vi.mocked(API.listFiles).mockResolvedValue({ files: [{ ...inFolder }, { ...atRoot }] } as never)
  vi.mocked(API.uploadFile).mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const b = blobs.get(String(url).replace('blob:', ''))
    return b
      ? { ok: true, status: 200, arrayBuffer: async () => b.slice().buffer }
      : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('key model phase 1: migrate without re-encrypting', () => {
  it('a file encrypted before the migration still opens after it, with the same blob', async () => {
    const before = new Map(blobs)
    const record = await runWrappedKeyMigration()

    expect(record).toMatchObject({ filesMigrated: 2 })
    expect(record?.failedFileIds).toBeUndefined()
    expect(Keys.wrappedKeyMode).toBe(true)
    // Nothing downloaded, re-encrypted or re-uploaded.
    expect(API.uploadFile).not.toHaveBeenCalled()
    expect(blobs).toEqual(before)
    // The folder event now carries the file's key, wrapped under the folder key.
    expect(relayEvents['folder-1'].tags.some((t) => t[0] === 'wk' && t[1] === 'file-old')).toBe(true)

    expect(text(await readFileBytes(migrated(inFolder)))).toBe(PLAINTEXT)
    expect(text(await readFileBytes(migrated(atRoot)))).toBe(PLAINTEXT)
  })

  it('a file whose folder event was destroyed still opens for the owner', async () => {
    await runWrappedKeyMigration()
    const folderRow = migrated(inFolder)
    const rootRow = migrated(atRoot)

    delete relayEvents['folder-1']
    loseDerivableKeys()

    expect(text(await readFileBytes(folderRow))).toBe(PLAINTEXT)
    expect(text(await readFileBytes(rootRow))).toBe(PLAINTEXT)
  })

  it('DISCRIMINATION: without the owner envelope, the same files do not open once the folder is gone', async () => {
    await runWrappedKeyMigration()
    delete relayEvents['folder-1']
    loseDerivableKeys()

    // With no keyring service (api: null) the lost root key cannot even be
    // fetched, so this fails at the key; in production a fresh root key would
    // derive a wrong file key and fail at decryption. Either way: no envelope,
    // no file.
    await expect(readFileBytes({ ...inFolder })).rejects.toThrow(/encryption key/)
    await expect(readFileBytes({ ...atRoot })).rejects.toThrow(/encryption key/)
  })
})
