// cloistr-audit on !238: an account switch stops a revoke-and-re-encrypt
// partway, which is the safe direction, but nothing said so. Once the new copy
// is published and before the old blob is gone, people the file was shared
// with can still open the old copy, so a half-done revoke must never read as
// done. The revoke now throws RevokeIncompleteError naming how far it got,
// keeps that record, and Sharing.retryRevoke finishes it, only for the account
// that started it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, OTHER, acct, published, calls, gate, holdAt } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  OTHER: 'b'.repeat(64),
  acct: { pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766' },
  published: [] as Array<{ kind: number; by: string }>,
  calls: { upload: 0, del: 0, notices: 0, deleted: [] as string[] },
  holdAt: { step: 'upload' as 'upload' | 'delete' | 'notice' },
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
    createUploadAuth: async () => (holdAt.step === 'upload' ? signBlossom() : 'Nostr x'),
    createDeleteAuth: async () => 'Nostr x',
    signEvent: async (e: Record<string, unknown>) => {
      // The revoke signs its blob removal (24242) here, then the share-record removals (5).
      if ((holdAt.step === 'delete' && e.kind === 24242) || (holdAt.step === 'notice' && e.kind === 5)) await signBlossom()
      return { ...e, id: 'id', sig: 'sig', pubkey: acct.pubkey }
    },
    publishEvent: async (e: { kind: number }) => {
      if (e.kind === 5) calls.notices++
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
    deleteFile: async (sha: string) => {
      calls.deleted.push(sha)
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
import { Sharing, RevokeIncompleteError } from './sharing'

const settle = () => new Promise((r) => setTimeout(r, 20))
const OLD = 'a'.repeat(64)
const FILE = { id: 'file-1', file_id: 'file-1', sha256: OLD, name: 'r.txt' } as never

function setAccount(pk: string) {
  Keys.clearCache()
  acct.pubkey = pk
  Keys.userPubkey = pk
}

/** Start a revoke, switch account at `step`, then let that signature return. */
async function revokeSwitchingAt(step: 'upload' | 'delete' | 'notice'): Promise<unknown> {
  holdAt.step = step
  gate.held = new Promise<void>((r) => (gate.release = r))
  gate.signed = false
  const run = Sharing.revokeAndReencryptFile(FILE).catch((e: unknown) => e)
  for (let i = 0; i < 50 && !gate.signed; i++) await settle()
  expect(gate.signed).toBe(true)
  setAccount(OTHER)
  gate.release()
  const out = await run
  await settle()
  holdAt.step = 'upload'
  gate.held = null
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
  setAccount(ME)
  Keys.keyCache.clear()
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  const key = await Keys.getFileKey(null, 'file-1')
  const blob = await Crypto.encryptFile(new Uint8Array([7, 7, 7]), key)
  vi.stubGlobal('fetch', async () => new Response(blob as BodyInit))
  vi.spyOn(Sharing, 'listOutgoingSharesForFile').mockResolvedValue([{ id: 'share-1' }] as never)
  published.length = 0
  Object.assign(calls, { upload: 0, del: 0, notices: 0, deleted: [] })
  gate.held = null
  gate.signed = false
  Sharing.clearPendingRevoke('file-1')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Keys.clearCache()
  Keys.storage = null
})

describe('a revoke stopped by an account switch is reported, kept, and finished on retry', () => {
  it('stopped before the new copy is published: nothing changed, retry runs it again', async () => {
    const out = await revokeSwitchingAt('upload')
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    expect((out as RevokeIncompleteError).pending.stage).toBe('not-started')
    expect(Sharing.pendingRevoke('file-1')?.stage).toBe('not-started')
    expect(calls.del).toBe(0)

    setAccount(ME)
    await Sharing.retryRevoke(FILE)
    expect(calls.deleted).toEqual([OLD])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('stopped with the old copy still stored: reported as such, retry removes it without re-encrypting again', async () => {
    const out = await revokeSwitchingAt('delete')
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    const pending = (out as RevokeIncompleteError).pending
    expect(pending).toMatchObject({ stage: 'old-copy-remains', pubkey: ME, fileId: 'file-1', oldSha256: OLD })
    expect(calls.del).toBe(0)
    expect(Sharing.pendingRevoke('file-1')).toEqual(pending)

    setAccount(ME)
    const uploadsBefore = calls.upload
    const result = await Sharing.retryRevoke(FILE)
    expect(calls.upload).toBe(uploadsBefore)
    expect(calls.deleted).toEqual([OLD])
    expect(calls.notices).toBe(1)
    expect(result.newFileId).toBe(pending.newFileId)
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('stopped while withdrawing share records: not reported as done, retry withdraws them', async () => {
    const out = await revokeSwitchingAt('notice')
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    expect((out as RevokeIncompleteError).pending.stage).toBe('share-notices')
    expect(calls.deleted).toEqual([OLD])
    expect(calls.notices).toBe(0)

    setAccount(ME)
    await Sharing.retryRevoke(FILE)
    expect(calls.notices).toBe(1)
    expect(calls.deleted).toEqual([OLD])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('a retry under a different account is refused and sends nothing', async () => {
    await revokeSwitchingAt('delete')
    const sent = { ...calls }
    await expect(Sharing.retryRevoke(FILE)).rejects.toThrow(/account/i)
    expect(calls.del).toBe(sent.del)
    expect(calls.upload).toBe(sent.upload)
    expect(Sharing.pendingRevoke('file-1')?.stage).toBe('old-copy-remains')
  })
})
