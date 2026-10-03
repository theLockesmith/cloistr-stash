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

import { runWrappedKeyMigration, isMigrationComplete } from './migration-wrapped-keys'
import { API } from './api'
import { authPort } from './authBridge'

const TEST_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

describe('runWrappedKeyMigration: partial failure', () => {
  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
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
    expect(isMigrationComplete(TEST_PUBKEY)).toBe(false)
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

    expect(isMigrationComplete(TEST_PUBKEY)).toBe(true)
    expect(Keys.wrappedKeyMode).toBe(true)
    expect(result).not.toBeNull()
    expect(result!.failedFileIds ?? []).toHaveLength(0)
  })
})

describe('Keys.getFileKey: derivation fallback warning', () => {
  const fileId = 'warn-file'
  const folderId = 'warn-folder'

  beforeEach(async () => {
    await Crypto.init()
    Keys.keyCache.clear()
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

  it('warns when wrappedKeyMode falls back to HKDF derivation', async () => {
    Keys.wrappedKeyMode = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // No envelope data provided, so it falls back to derivation
    await Keys.getFileKey(folderId, fileId)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to HKDF derivation'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })

  it('does NOT warn when wrappedKeyMode is false', async () => {
    Keys.wrappedKeyMode = false
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await Keys.getFileKey(folderId, fileId)

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('falling back to HKDF derivation'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })
})
