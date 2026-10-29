// cloistr-audit on !237: the Blossom auth (kind 24242) was fenced before it was
// signed but not after. Over NIP-46 the signature takes seconds, so switching
// account in that gap still sent the PUT, spending the new account's quota on a
// blob it holds no key for. Every Blossom upload and delete now checks the
// account again between signing and sending, and re-encrypt on revoke and the
// public copy check it at all.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, OTHER, acct, published, calls, gate } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  OTHER: 'b'.repeat(64),
  acct: { pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766' },
  published: [] as Array<{ kind: number; by: string }>,
  calls: { upload: 0, del: 0 },
  // The first Blossom auth signature waits here, as a NIP-46 round trip does.
  gate: { held: null as Promise<void> | null, release: () => {}, signed: false },
}))

async function signBlossom() {
  if (gate.held && !gate.signed) {
    gate.signed = true
    await gate.held
  }
  return 'Nostr x'
}

const signer = {
  getPublicKey: async () => acct.pubkey,
  nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
  nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
}

vi.mock('./relay', () => ({ Relay: { subscribe: async () => [], query: async () => [] } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    get pubkey() {
      return acct.pubkey
    },
    createUploadAuth: signBlossom,
    createDeleteAuth: signBlossom,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: acct.pubkey }),
    publishEvent: async (e: { kind: number }) => {
      published.push({ kind: e.kind, by: acct.pubkey })
    },
  },
  getSigner: () => signer,
}))
vi.mock('./api', () => ({
  API: {
    uploadFile: async () => {
      calls.upload++
      return { sha256: 'e'.repeat(64) }
    },
    deleteFile: async () => {
      calls.del++
      return {}
    },
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
  },
}))
vi.mock('./search', () => ({ Search: { indexFile: async () => {} } }))
vi.mock('./sealedDrive', () => ({ writesSealed: async () => false, writeContext: async () => ({}) }))
vi.mock('./versioning', () => ({ Versioning: { getVersionHistory: async () => [] } }))

import { Keys } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { uploadFiles, uploadEncryptedBytes } from './upload'
import { Sharing } from './sharing'
import { publishPublicly } from './publish'
import { deleteFileBlobs } from './operations'

const settle = () => new Promise((r) => setTimeout(r, 20))

/** Start `action`, switch account while its Blossom auth is being signed, then let the signature return. */
async function switchWhileSigning<T>(action: () => Promise<T>): Promise<T | Error> {
  gate.held = new Promise<void>((r) => (gate.release = r))
  const run = action().catch((e: Error) => e)
  for (let i = 0; i < 50 && !gate.signed; i++) await settle()
  expect(gate.signed).toBe(true)
  Keys.clearCache()
  acct.pubkey = OTHER
  Keys.userPubkey = OTHER
  gate.release()
  const out = await run
  await settle()
  return out
}

beforeEach(async () => {
  await Crypto.init()
  Keys.setStorage(new InMemoryKeyStorage())
  const auth: AuthPort = {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
  }
  Keys.configure({ auth })
  Keys.nip44Writes = true
  acct.pubkey = ME
  Keys.userPubkey = ME
  Keys.keyCache.clear()
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  published.length = 0
  calls.upload = 0
  calls.del = 0
  gate.held = null
  gate.signed = false
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Keys.clearCache()
  Keys.storage = null
})

describe('an account switch while the Blossom auth is signed sends nothing', () => {
  it('upload: no PUT', async () => {
    const out = await switchWhileSigning(() => uploadFiles([new File(['hello'], 'a.txt', { type: 'text/plain' })], { folderId: null }))
    expect((out as Array<{ status: string }>)[0].status).toBe('error')
    expect(calls.upload).toBe(0)
    expect(published).toEqual([])
  })

  it('upload of raw bytes: no PUT', async () => {
    const out = await switchWhileSigning(() => uploadEncryptedBytes(new Uint8Array([1, 2, 3]), 'b.bin', 'application/octet-stream'))
    expect(out).toBeInstanceOf(Error)
    expect(calls.upload).toBe(0)
    expect(published).toEqual([])
  })

  it('revoke and re-encrypt: no PUT, no publish, no delete', async () => {
    const key = await Keys.getFileKey(null, 'file-1')
    const blob = await Crypto.encryptFile(new Uint8Array([7, 7, 7]), key)
    vi.stubGlobal('fetch', async () => new Response(blob as BodyInit))
    const out = await switchWhileSigning(() =>
      Sharing.revokeAndReencryptFile({ id: 'file-1', file_id: 'file-1', sha256: 'a'.repeat(64), name: 'r.txt' } as never),
    )
    expect(out).toBeInstanceOf(Error)
    expect(calls.upload).toBe(0)
    expect(calls.del).toBe(0)
    expect(published).toEqual([])
  })

  it('public copy: no PUT', async () => {
    const out = await switchWhileSigning(() =>
      publishPublicly({ sha256: 'a'.repeat(64), name: 'p.txt' } as never, async () => new Uint8Array([1])),
    )
    expect(out).toBeInstanceOf(Error)
    expect(calls.upload).toBe(0)
  })

  it('permanent removal: no DELETE', async () => {
    const out = await switchWhileSigning(() =>
      deleteFileBlobs([{ id: 'file-1', sha256: 'a'.repeat(64) } as never], Keys.accountFence() ?? undefined),
    )
    expect(out).toBeInstanceOf(Error)
    expect(calls.del).toBe(0)
  })
})
