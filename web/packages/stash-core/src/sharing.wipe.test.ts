// shareFile and generatePublicLink must wipe the file key once it has been
// encoded (orchestrator, 2026-10-07; same shape as the !156 wipe tests). For a
// wrapped file this is the file's only key, not one re-derivable from root.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const FILE_KEY = new Uint8Array(32).fill(0x5a)
const wiped: Uint8Array[] = []

vi.mock('./crypto', () => ({
  Crypto: {
    bytesToHex: (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''),
    bytesToBase64url: () => 'key-b64url',
    wipeKey: (k: Uint8Array) => {
      wiped.push(k.slice())
    },
  },
}))

let failEncrypt = false
vi.mock('./keys', () => ({
  Keys: {
    getFileKey: async () => FILE_KEY.slice(),
    deriveFileKey: async () => FILE_KEY.slice(),
    deriveRootFileKey: async () => FILE_KEY.slice(),
    unwrapFileKeyFromOwner: async () => FILE_KEY.slice(),
    selfEncrypt: async () => {
      if (failEncrypt) throw new Error('signer refused')
      return 'enc'
    },
    encryptForRecipient: async () => 'enc',
  },
}))

vi.mock('./api', () => ({ API: { getDownloadURL: (s: string) => `blob:${s}` } }))
vi.mock('./relay', () => ({ Relay: { subscribe: vi.fn(async () => []) } }))
vi.mock('./upload', () => ({ addWrappedKeyToFolder: vi.fn(async () => {}) }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: 'owner-pubkey',
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: 'owner-pubkey' }),
    publishEvent: async () => {},
    nip44Encrypt: async () => 'enc',
    nip04Encrypt: async () => 'enc',
  },
  getSigner: () => ({ signEvent: async (e: unknown) => e }),
}))

import { Sharing } from './sharing'

const file = { id: 'file-1', folder: 'folder-1', sha256: 'abc', name: 'a.txt', owner_key: 'env' }
const recipient = 'b'.repeat(64)

beforeEach(() => {
  wiped.length = 0
  failEncrypt = false
})

describe('file key is wiped after sharing', () => {
  it('shareFile wipes the key on success', async () => {
    vi.spyOn(Sharing, 'encryptForRecipient').mockResolvedValue('enc')
    await Sharing.shareFile(file as never, recipient)
    expect(wiped).toContainEqual(FILE_KEY)
  })

  it('shareFile wipes the key when encrypting for the recipient fails', async () => {
    vi.spyOn(Sharing, 'encryptForRecipient').mockRejectedValue(new Error('signer refused'))
    await expect(Sharing.shareFile(file as never, recipient)).rejects.toThrow('signer refused')
    expect(wiped).toContainEqual(FILE_KEY)
  })

  it('generatePublicLink wipes the key once it is in the link', async () => {
    const res = await Sharing.generatePublicLink(file as never, 'https://stash.example')
    expect(res.url).toBe('https://stash.example/public/abc#key-b64url')
    expect(wiped).toContainEqual(FILE_KEY)
  })
})
