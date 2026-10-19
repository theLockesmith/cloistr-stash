// Receiving a share (STASH-19, found live 2026-10-19): the recipient pressed
// Accept and nothing changed. The share kept its Accept button and the file
// could never be downloaded, because the React port dropped the legacy
// Shared view's Download and never recorded the acceptance. These tests pin
// the two pieces the view now relies on: downloadSharedFile, and the
// `accepted` flag on listIncomingShares.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ME = 'c'.repeat(64)
const ALICE = 'a'.repeat(64)

vi.mock('./api', () => ({
  API: {
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
    listShares: vi.fn(async () => ({ received: [] })),
  },
}))
vi.mock('./relay', () => ({ Relay: { subscribe: vi.fn(async () => []) } }))
vi.mock('./upload', () => ({ addWrappedKeyToFolder: vi.fn(async () => {}) }))
vi.mock('./authBridge', () => ({
  authPort: { isConnected: true, pubkey: 'c'.repeat(64) },
  getSigner: () => null,
}))

import { Sharing, type DecryptedIncomingShare, type IncomingShare } from './sharing'
import { Keys } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'

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

const PLAINTEXT = new TextEncoder().encode('hello from alice')
let fileKey: Uint8Array
let blob: Uint8Array
let blobSha: string
const fetchMock = vi.fn()

/** An incoming file share exactly as Alice's shareFile publishes it (NIP-44 to us). */
function fileShare(id: string, overrides: Record<string, unknown> = {}): IncomingShare {
  const content = {
    type: 'file',
    fileId: 'file-1',
    fileName: 'hello.txt',
    fileSize: PLAINTEXT.length,
    fileMimeType: 'text/plain',
    fileSHA256: blobSha,
    fileURL: 'https://evil.test/elsewhere',
    fileKey: `nip44:${Crypto.bytesToHex(fileKey)}`,
    encrypted: true,
    ...overrides,
  }
  return { id, owner_pubkey: ALICE, encrypted_content: `nip44:${JSON.stringify(content)}` }
}

async function asListed(share: IncomingShare): Promise<DecryptedIncomingShare> {
  vi.spyOn(Sharing, 'queryIncomingSharesFromRelay').mockResolvedValue([share])
  const [listed] = await Sharing.listIncomingShares()
  return listed
}

beforeEach(async () => {
  await Crypto.init()
  Keys.setStorage(new InMemoryKeyStorage())
  Keys.configure({ auth: mockAuth() })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  fileKey = Crypto.generateKey()
  blob = await Crypto.encryptFile(PLAINTEXT.slice(), fileKey)
  blobSha = await Crypto.hash(blob)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(blob.slice()))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Keys.clearCache()
  Keys.setStorage(null)
})

describe('downloadSharedFile', () => {
  it('decrypts the shared blob with the key in the share', async () => {
    const result = await Sharing.downloadSharedFile(await asListed(fileShare('s1')))
    expect(new TextDecoder().decode(result.data)).toBe('hello from alice')
    expect(result.name).toBe('hello.txt')
    expect(result.mimeType).toBe('text/plain')
  })

  it('fetches from our Blossom by hash, never from the URL the sender wrote into the share', async () => {
    await Sharing.downloadSharedFile(await asListed(fileShare('s1')))
    expect(fetchMock).toHaveBeenCalledWith(`https://blossom.test/${blobSha}`)
    expect(fetchMock.mock.calls.flat().join(' ')).not.toContain('evil.test')
  })

  it('refuses a blob whose hash is not the one in the share', async () => {
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])))
    await expect(Sharing.downloadSharedFile(await asListed(fileShare('s1')))).rejects.toThrow(/hash/i)
  })

  it('refuses a share that is not a file', async () => {
    const folder = fileShare('s2', { type: 'folder', folderId: 'f1', folderKey: 'nip44:00' })
    await expect(Sharing.downloadSharedFile(await asListed(folder))).rejects.toThrow()
  })
})

describe('accepting a share is remembered', () => {
  it('a file share is not accepted until Accept, and stays accepted on the next listing', async () => {
    const share = fileShare('s1')
    expect((await asListed(share)).accepted).toBe(false)
    await Sharing.acceptShare(await asListed(share))
    Keys.keyCache.clear()
    expect((await asListed(share)).accepted).toBe(true)
  })

  it('a folder share is accepted once its folder key is stored', async () => {
    const folderKey = Crypto.generateKey()
    const share = fileShare('s2', {
      type: 'folder',
      folderId: 'f-alice',
      folderName: 'From Alice',
      folderKey: `nip44:${Crypto.bytesToHex(folderKey)}`,
    })
    expect((await asListed(share)).accepted).toBe(false)
    await Sharing.acceptShare(await asListed(share))
    Keys.keyCache.clear()
    expect((await asListed(share)).accepted).toBe(true)
  })
})
