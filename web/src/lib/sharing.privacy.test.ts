import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing Sharing
vi.mock('./crypto', () => ({
  Crypto: {
    bytesToHex: (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''),
    hexToBytes: (h: string) => new Uint8Array(h.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
    bytesToBase64url: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
    base64urlToBytes: () => new Uint8Array(32),
    generateFileId: () => 'deadbeef'.repeat(4),
    encryptFile: async (d: ArrayBuffer) => d,
    decryptFile: async (d: ArrayBuffer) => new Uint8Array(d),
    hash: async () => 'abc123',
    wipeKey: () => {},
  },
}))

vi.mock('./keys', () => ({
  Keys: {
    deriveFileKey: async () => new Uint8Array(32),
    deriveRootFileKey: async () => new Uint8Array(32),
    getFolderKey: async () => new Uint8Array(32),
    selfEncrypt: vi.fn(async (_pk: string, pt: string) => `enc:${pt}`),
    selfDecrypt: vi.fn(async (_pk: string, ct: string) => ct.replace('enc:', '')),
    storeEncryptedKey: async () => {},
    importSharedFolderKey: async () => {},
  },
}))

vi.mock('./api', () => ({
  API: {
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
    uploadFile: async () => ({ sha256: 'newhash' }),
    deleteFile: async () => {},
    listShares: async () => ({ shares: [] }),
  },
}))

vi.mock('./relay', () => ({
  Relay: {
    subscribe: vi.fn(async () => []),
  },
}))

vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: 'author_pubkey_abc',
    signEvent: async (e: Record<string, unknown>) => ({ ...e, sig: 'sig', id: 'evtid' }),
    publishEvent: async () => {},
    createUploadAuth: async () => 'auth',
  },
}))

import { Sharing } from './sharing'
import { Relay } from './relay'

describe('Share event privacy: no item coordinates in plaintext tags', () => {
  it('createShareEvent omits file, folder, and permission tags', async () => {
    const event = await Sharing.createShareEvent({
      id: 'share123',
      recipientPubkey: 'recipient_pub',
      shareContent: {
        type: 'file',
        fileId: 'secret_file_id',
        fileName: 'secret.txt',
        fileSize: 100,
        fileMimeType: 'text/plain',
        fileSHA256: 'sha',
        fileURL: 'https://blossom.test/sha',
        fileKey: 'enc:key',
        message: '',
        encrypted: true,
      },
      permission: 'edit',
      expiresAt: null,
    })

    const tagKeys = event.tags.map((t: string[]) => t[0])

    expect(tagKeys).toContain('d')
    expect(tagKeys).toContain('p')
    expect(tagKeys).not.toContain('file')
    expect(tagKeys).not.toContain('folder')
    expect(tagKeys).not.toContain('permission')

    // Verify permission and file info are in the encrypted content
    const decrypted = (event.content as string).replace('enc:', '')
    const content = JSON.parse(decrypted)
    expect(content.permission).toBe('edit')
    expect(content.fileId).toBe('secret_file_id')
    expect(content.fileName).toBe('secret.txt')
  })

  it('expiration tag is present when set (NIP-40 relay support)', async () => {
    const event = await Sharing.createShareEvent({
      id: 'share456',
      recipientPubkey: 'recipient_pub',
      shareContent: {
        type: 'file',
        fileId: 'fid',
        fileName: 'f.txt',
        fileSize: 1,
        fileMimeType: 'text/plain',
        fileSHA256: 'sha',
        fileURL: 'url',
        fileKey: 'k',
        message: '',
        encrypted: true,
      },
      permission: 'view',
      expiresAt: 1700000000,
    })

    const expTag = event.tags.find((t: string[]) => t[0] === 'expiration')
    expect(expTag).toBeDefined()
    expect(expTag![1]).toBe('1700000000')

    // Also inside encrypted payload
    const decrypted = (event.content as string).replace('enc:', '')
    const content = JSON.parse(decrypted)
    expect(content.expiresAt).toBe(1700000000)
  })

  it('folder share also omits folder tag from plaintext', async () => {
    const event = await Sharing.createShareEvent({
      id: 'sharefolder',
      recipientPubkey: 'recipient_pub',
      shareContent: {
        type: 'folder',
        folderId: 'secret_folder_id',
        folderName: 'Private Docs',
        folderKey: 'enc:folderkey',
        message: '',
      },
      permission: 'download',
      expiresAt: null,
    })

    const tagKeys = event.tags.map((t: string[]) => t[0])
    expect(tagKeys).not.toContain('folder')
    expect(tagKeys).not.toContain('permission')

    const decrypted = (event.content as string).replace('enc:', '')
    const content = JSON.parse(decrypted)
    expect(content.folderId).toBe('secret_folder_id')
    expect(content.permission).toBe('download')
  })
})

describe('listOutgoingSharesForFile: decrypt-then-filter', () => {
  beforeEach(() => {
    vi.mocked(Relay.subscribe).mockReset()
  })

  it('decrypts outgoing share events and filters by fileId', async () => {
    const shareContent = JSON.stringify({
      type: 'file',
      fileId: 'target_file',
      fileName: 'match.txt',
      permission: 'view',
      expiresAt: null,
    })
    const otherContent = JSON.stringify({
      type: 'file',
      fileId: 'other_file',
      fileName: 'nope.txt',
      permission: 'edit',
    })

    vi.mocked(Relay.subscribe).mockResolvedValue([
      {
        id: 'evt1',
        pubkey: 'author_pubkey_abc',
        tags: [['d', 'share_a'], ['p', 'recip1']],
        content: `enc:${shareContent}`,
        created_at: 1700000000,
      },
      {
        id: 'evt2',
        pubkey: 'author_pubkey_abc',
        tags: [['d', 'share_b'], ['p', 'recip2']],
        content: `enc:${otherContent}`,
        created_at: 1700000000,
      },
    ] as never[])

    const results = await Sharing.listOutgoingSharesForFile('target_file')

    expect(results).toHaveLength(1)
    expect(results[0].recipientPubkey).toBe('recip1')
    expect(results[0].permission).toBe('view')
  })

  it('skips events it cannot decrypt', async () => {
    vi.mocked(Relay.subscribe).mockResolvedValue([
      {
        id: 'evt_bad',
        pubkey: 'author_pubkey_abc',
        tags: [['d', 'share_x'], ['p', 'recip_x']],
        content: 'garbled_nonsense',
        created_at: 1700000000,
      },
    ] as never[])

    const results = await Sharing.listOutgoingSharesForFile('any')
    expect(results).toHaveLength(0)
  })
})
