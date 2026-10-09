// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Keys } from './keys'
import { Crypto } from './crypto'

// Mock modules before importing migration
vi.mock('./api', () => ({
  API: {
    listFolders: vi.fn(),
    listFiles: vi.fn(),
  },
}))

vi.mock('./events', () => ({
  Events: {
    createEncryptedFileMetadataEvent: vi.fn(async () => ({ kind: 30078 })),
    createEncryptedFolderEvent: vi.fn(async () => ({ kind: 30079 })),
  },
}))

vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
    publishEvent: vi.fn(async () => {}),
    signEvent: vi.fn(async (e: unknown) => e),
  },
  getSigner: () => ({
    async getPublicKey() { return '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766' },
    async signEvent(event: unknown) { return event },
    async encrypt(_pk: string, pt: string) { return `nip04:${pt}` },
    async decrypt(_pk: string, ct: string) { return ct.replace('nip04:', '') },
    async nip44Encrypt(_pk: string, pt: string) { return `nip44:${pt}` },
    async nip44Decrypt(_pk: string, ct: string) { return ct.replace('nip44:', '') },
  }),
}))

vi.mock('./relay', () => ({
  Relay: {
    subscribe: vi.fn(async () => []),
  },
}))

import { runWrappedKeyMigration, isMigrationComplete } from './migration-wrapped-keys'
import { API } from './api'
import { authPort } from './authBridge'
import { Relay } from './relay'
import { InMemoryKeyStorage } from './key-storage'

const TEST_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

// A relay holding the user's current folder/file events (keyed by d tag) and
// no migration record. Tests put events in `relayEvents` to shape what it holds.
let relayEvents: Record<string, { kind: number; created_at: number; tags: string[][]; content: string }> = {}
function relayHoldsEvents() {
  vi.mocked(Relay.subscribe).mockImplementation((async (f: { kinds: number[]; '#d'?: string[] }) => {
    const d = f['#d']?.[0] ?? ''
    if (d === 'wrapped-key-migration') return []
    return [relayEvents[d] ?? { kind: f.kinds[0], created_at: 1, tags: [['d', d]], content: '{"name":"x"}' }]
  }) as never)
}

describe('runWrappedKeyMigration: partial failure', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
    // migration checks the key store for folder-key provenance
    Keys.setStorage(new InMemoryKeyStorage())
    Keys.userPubkey = TEST_PUBKEY
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

    // Prime root key and pre-derive folder keys so migration doesn't hit IndexedDB
    const rootKey = Crypto.generateKey()
    Keys.keyCache.set('root', rootKey)
    const folderKey = await Keys.deriveKey(rootKey, 'folder-1', Keys.CONTEXT_FOLDER)
    Keys.keyCache.set('folder:folder-1', folderKey)

    // Clear localStorage migration state
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith('cloistr-drive-wrapped-key-migration')) {
        localStorage.removeItem(key)
      }
    }

    vi.clearAllMocks()
    relayEvents = {}
    relayHoldsEvents()
  })

  it('does NOT mark migration complete when a file fails', async () => {
    const folders = [
      { id: 'folder-1', name: 'test', parent_id: null },
    ]
    const files = [
      { id: 'file-ok', sha256: 'abc123abcdef1234', encrypted: true, folder_id: 'folder-1', name: 'ok.txt', size: 100, mime_type: 'text/plain' },
      { id: 'file-fail', sha256: 'def456abcdef5678', encrypted: true, folder_id: 'folder-1', name: 'fail.txt', size: 200, mime_type: 'text/plain' },
    ]

    vi.mocked(API.listFolders).mockResolvedValue({ folders } as never)
    vi.mocked(API.listFiles).mockResolvedValue({ files } as never)

    // Make publishEvent fail on the second file's metadata event
    let publishCount = 0
    vi.mocked(authPort.publishEvent).mockImplementation(async (event: unknown) => {
      const e = event as { kind: number }
      if (e.kind === 30078) {
        publishCount++
        if (publishCount === 2) {
          throw new Error('relay offline')
        }
      }
    })

    const result = await runWrappedKeyMigration()

    // Migration should NOT be marked complete
    expect(await isMigrationComplete(TEST_PUBKEY)).toBe(false)
    expect(Keys.wrappedKeyMode).toBe(false)
    // Result should indicate partial failure
    expect(result).not.toBeNull()
    expect(result!.failedFileIds).toBeDefined()
    expect(result!.failedFileIds!.length).toBeGreaterThan(0)
  })

  it('rerun after partial failure completes the migration', async () => {
    const folders = [
      { id: 'folder-1', name: 'test', parent_id: null },
    ]
    const fileOk = { id: 'file-ok', sha256: 'abc123abcdef1234', encrypted: true, folder_id: 'folder-1', name: 'ok.txt', size: 100, mime_type: 'text/plain', owner_key: 'already-wrapped' }
    const fileFail = { id: 'file-fail', sha256: 'def456abcdef5678', encrypted: true, folder_id: 'folder-1', name: 'fail.txt', size: 200, mime_type: 'text/plain' }

    vi.mocked(API.listFolders).mockResolvedValue({ folders } as never)
    // On rerun, file-ok already has owner_key (will be skipped), file-fail does not
    vi.mocked(API.listFiles).mockResolvedValue({ files: [fileOk, fileFail] } as never)
    vi.mocked(authPort.publishEvent).mockResolvedValue(undefined)

    const result = await runWrappedKeyMigration()

    expect(await isMigrationComplete(TEST_PUBKEY)).toBe(true)
    expect(Keys.wrappedKeyMode).toBe(true)
    expect(result).not.toBeNull()
    expect(result!.failedFileIds ?? []).toHaveLength(0)
  })
})

describe('migration record on relay', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
    // migration checks the key store for folder-key provenance
    Keys.setStorage(new InMemoryKeyStorage())
    Keys.userPubkey = TEST_PUBKEY
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

    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith('cloistr-drive-wrapped-key-migration')) {
        localStorage.removeItem(key)
      }
    }

    vi.clearAllMocks()
    relayEvents = {}
    relayHoldsEvents()
  })

  it('completed migration publishes record to relay', async () => {
    const rootKey = Crypto.generateKey()
    Keys.keyCache.set('root', rootKey)
    const folderKey = await Keys.deriveKey(rootKey, 'folder-1', Keys.CONTEXT_FOLDER)
    Keys.keyCache.set('folder:folder-1', folderKey)

    vi.mocked(API.listFolders).mockResolvedValue({ folders: [{ id: 'folder-1', name: 'test', parent_id: null }] } as never)
    vi.mocked(API.listFiles).mockResolvedValue({
      files: [{ id: 'file-1', sha256: 'abc123abcdef1234', encrypted: true, folder_id: 'folder-1', name: 'ok.txt', size: 100, mime_type: 'text/plain' }],
    } as never)
    vi.mocked(authPort.publishEvent).mockResolvedValue(undefined)

    await runWrappedKeyMigration()

    const publishCalls = vi.mocked(authPort.publishEvent).mock.calls
    const migrationEvent = publishCalls.find((call) => {
      const event = call[0] as { kind?: number; tags?: string[][] }
      return event.kind === 30078 && event.tags?.some((t) => t[0] === 'd' && t[1] === 'wrapped-key-migration')
    })
    expect(migrationEvent).toBeTruthy()
  })

  it('isMigrationComplete queries relay when localStorage is empty', async () => {
    const encryptedRecord = 'nip44:' + JSON.stringify({ version: 1, completedAt: Date.now(), filesMigrated: 5, foldersMigrated: 2 })
    vi.mocked(Relay.subscribe).mockResolvedValue([
      { kind: 30078, tags: [['d', 'wrapped-key-migration']], content: encryptedRecord, pubkey: TEST_PUBKEY },
    ] as never)

    const result = await isMigrationComplete(TEST_PUBKEY)
    expect(result).toBe(true)

    // Should have queried relay
    expect(Relay.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: [30078], '#d': ['wrapped-key-migration'] }),
      expect.any(Number),
    )
  })

  it('HEADLESS: isMigrationComplete reads the relay record when localStorage does not exist', async () => {
    const encryptedRecord = 'nip44:' + JSON.stringify({ version: 1, completedAt: Date.now(), filesMigrated: 1, foldersMigrated: 1 })
    vi.mocked(Relay.subscribe).mockResolvedValue([
      { kind: 30078, tags: [['d', 'wrapped-key-migration']], content: encryptedRecord, pubkey: TEST_PUBKEY },
    ] as never)
    vi.stubGlobal('localStorage', undefined)
    try {
      expect(await isMigrationComplete(TEST_PUBKEY)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HEADLESS: completed migration still publishes the relay record when localStorage does not exist', async () => {
    const rootKey = Crypto.generateKey()
    Keys.keyCache.set('root', rootKey)
    vi.mocked(API.listFolders).mockResolvedValue({ folders: [] } as never)
    vi.mocked(API.listFiles).mockResolvedValue({ files: [] } as never)
    vi.mocked(authPort.publishEvent).mockResolvedValue(undefined)
    vi.mocked(Relay.subscribe).mockResolvedValue([]) // no record on the relay yet
    vi.stubGlobal('localStorage', undefined)
    try {
      await runWrappedKeyMigration()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(Keys.wrappedKeyMode).toBe(true)
    const published = vi.mocked(authPort.publishEvent).mock.calls.some((call) => {
      const e = call[0] as { tags?: string[][] }
      return e.tags?.some((t) => t[0] === 'd' && t[1] === 'wrapped-key-migration')
    })
    expect(published).toBe(true)
  })

  it('isMigrationComplete caches relay result to localStorage', async () => {
    const record = { version: 1, completedAt: Date.now(), filesMigrated: 3, foldersMigrated: 1 }
    const encryptedRecord = 'nip44:' + JSON.stringify(record)
    vi.mocked(Relay.subscribe).mockResolvedValue([
      { kind: 30078, tags: [['d', 'wrapped-key-migration']], content: encryptedRecord, pubkey: TEST_PUBKEY },
    ] as never)

    await isMigrationComplete(TEST_PUBKEY)

    const cached = localStorage.getItem(`cloistr-drive-wrapped-key-migration:${TEST_PUBKEY}`)
    expect(cached).not.toBeNull()
    expect(JSON.parse(cached!).version).toBe(1)
  })
})

describe('Keys.getFileKey: derivation fallback warning', () => {
  const fileId = 'warn-file'
  const folderId = 'warn-folder'

  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
    // migration checks the key store for folder-key provenance
    Keys.setStorage(new InMemoryKeyStorage())
    Keys.userPubkey = TEST_PUBKEY
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
    const folderKey = await Keys.deriveKey(rootKey, folderId, 'cloistr-drive-folder-v1')
    Keys.keyCache.set(`folder:${folderId}`, folderKey)
  })

  it('HKDF fallback still works for pre-migration files without envelopes', async () => {
    Keys.wrappedKeyMode = true
    const result = await Keys.getFileKey(folderId, fileId)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(32)
  })
})

// Sweep item #10 (2026-10-09): a relay that did not answer read as "not
// migrated", so the migration re-ran on sign-in and rewrote each folder event
// with only the files it migrated that time, dropping every earlier wk tag.
describe('migration: unknown is not "not migrated", and re-runs never drop data', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
    Keys.setStorage(new InMemoryKeyStorage())
    Keys.userPubkey = TEST_PUBKEY
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
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith('cloistr-drive-wrapped-key-migration')) localStorage.removeItem(key)
    }
    vi.clearAllMocks()
    relayEvents = {}
    relayHoldsEvents()
    vi.mocked(API.listFolders).mockResolvedValue({ folders: [{ id: 'folder-1', name: 'test', parent_id: null }] } as never)
    vi.mocked(API.listFiles).mockResolvedValue({
      files: [{ id: 'file-new', sha256: 'abc123abcdef1234', encrypted: true, folder_id: 'folder-1', name: 'n.txt', size: 1, mime_type: 'text/plain' }],
    } as never)
  })

  it('relay does not answer the migration-record query: isMigrationComplete throws, the migration does not run', async () => {
    vi.mocked(Relay.subscribe).mockRejectedValue(new Error('Subscription timeout'))
    await expect(isMigrationComplete(TEST_PUBKEY)).rejects.toThrow()
    expect(await runWrappedKeyMigration()).toBeNull()
    expect(vi.mocked(authPort.publishEvent)).not.toHaveBeenCalled()
    expect(Keys.wrappedKeyMode).toBe(false)
  })

  it('a re-run merges into the folder event: earlier wk tags and other tags survive', async () => {
    relayEvents['folder-1'] = {
      kind: 30079,
      created_at: 1,
      tags: [['d', 'folder-1'], ['encrypted', 'true'], ['key', 'KEYTAG'], ['wk', 'file-old', 'OLD-ENVELOPE'], ['x-future', 'kept']],
      content: JSON.stringify({ name: 'test', description: 'd', encrypted: true }),
    }
    await runWrappedKeyMigration()
    const folderEvent = vi.mocked(authPort.publishEvent).mock.calls
      .map((c) => c[0] as { kind: number; tags: string[][] })
      .find((e) => e.kind === 30079)!
    expect(folderEvent.tags).toContainEqual(['wk', 'file-old', 'OLD-ENVELOPE'])
    expect(folderEvent.tags.some((t) => t[0] === 'wk' && t[1] === 'file-new')).toBe(true)
    expect(folderEvent.tags).toContainEqual(['key', 'KEYTAG'])
    expect(folderEvent.tags).toContainEqual(['x-future', 'kept'])
  })

  it('a file re-published by the migration keeps its version history and existing tags', async () => {
    relayEvents['file-new'] = {
      kind: 30078,
      created_at: 1,
      tags: [['d', 'file-new'], ['x', 'abc123abcdef1234'], ['encrypted', 'xchacha20-poly1305'], ['folder', 'folder-1'], ['v', 'abc123abcdef1234', '3', '1', TEST_PUBKEY], ['current', 'abc123abcdef1234']],
      content: JSON.stringify({ name: 'n.txt', size: 1, encrypted: true }),
    }
    await runWrappedKeyMigration()
    const fileEvent = vi.mocked(authPort.publishEvent).mock.calls
      .map((c) => c[0] as { kind: number; tags: string[][] })
      .find((e) => e.kind === 30078 && e.tags.some((t) => t[0] === 'd' && t[1] === 'file-new'))!
    expect(fileEvent.tags).toContainEqual(['v', 'abc123abcdef1234', '3', '1', TEST_PUBKEY])
    expect(fileEvent.tags).toContainEqual(['current', 'abc123abcdef1234'])
    expect(fileEvent.tags.some((t) => t[0] === 'owner_key' && !!t[1])).toBe(true)
  })

  it('a file whose relay event already has owner_key is not re-wrapped', async () => {
    relayEvents['file-new'] = {
      kind: 30078, created_at: 1,
      tags: [['d', 'file-new'], ['encrypted', 'xchacha20-poly1305'], ['folder', 'folder-1'], ['owner_key', 'REAL-ENVELOPE']],
      content: '{"name":"n.txt"}',
    }
    await runWrappedKeyMigration()
    const fileEvents = vi.mocked(authPort.publishEvent).mock.calls
      .map((c) => c[0] as { kind: number; tags: string[][] })
      .filter((e) => e.kind === 30078 && e.tags.some((t) => t[0] === 'd' && t[1] === 'file-new'))
    expect(fileEvents).toEqual([])
  })

  it('a folder whose event cannot be loaded is skipped and the migration is not marked complete', async () => {
    vi.mocked(Relay.subscribe).mockImplementation((async (f: { '#d'?: string[] }) => {
      if (f['#d']?.[0] === 'wrapped-key-migration') return []
      throw new Error('Subscription timeout')
    }) as never)
    const result = await runWrappedKeyMigration()
    expect(result?.failedFileIds).toContain('file-new')
    expect(vi.mocked(authPort.publishEvent)).not.toHaveBeenCalled()
    expect(Keys.wrappedKeyMode).toBe(false)
  })
})
