// cloistr-audit on !235: uploads and shares fetched the folder key with no
// account fence. Over NIP-46 that fetch takes seconds, so switching account
// mid-action could derive from the new account's root, store the result under
// the new account, and publish as the new account. Each action now records the
// account it began for and stops, writing nothing, once that changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, OTHER, acct, published, relay } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  OTHER: 'b'.repeat(64),
  acct: { pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766' },
  published: [] as Array<{ kind: number; tags: string[][]; content: string; by: string }>,
  relay: { events: [] as Array<{ kind: number; tags: string[][]; content: string }> },
}))

const signer = {
  getPublicKey: async () => acct.pubkey,
  nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
  nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
}

vi.mock('./relay', () => ({ Relay: { subscribe: async () => relay.events, query: async () => [] } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    get pubkey() {
      return acct.pubkey
    },
    createUploadAuth: async () => 'Nostr x',
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: acct.pubkey }),
    publishEvent: async (e: { kind: number; tags: string[][]; content: string }) => {
      published.push({ ...e, by: acct.pubkey })
    },
  },
  getSigner: () => signer,
}))
vi.mock('./api', () => ({
  API: {
    uploadFile: async () => ({}),
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
    deleteFile: async () => ({}),
  },
}))
vi.mock('./search', () => ({ Search: { indexFile: async () => {} } }))
vi.mock('./sealedDrive', () => ({ writesSealed: async () => false, writeContext: async () => ({}) }))

import { Keys } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { uploadFiles } from './upload'
import { Sharing } from './sharing'

const settle = () => new Promise((r) => setTimeout(r, 20))
const storedUnder = async (pk: string) => (await Keys.storage!.list(pk)).map((r) => r.keyId)
const RECIPIENT = 'c'.repeat(64)

/** Holds the first call to Keys[method] until release(). */
function hold(method: 'loadEncryptedKey' | 'wrapFileKeyForOwner') {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const real = (Keys[method] as (...a: unknown[]) => Promise<unknown>).bind(Keys)
  let first = true
  vi.spyOn(Keys, method).mockImplementation((async (...args: unknown[]) => {
    if (first) {
      first = false
      await gate
    }
    return real(...args)
  }) as never)
  return release
}

async function switchAccount() {
  Keys.clearCache()
  acct.pubkey = OTHER
  Keys.userPubkey = OTHER
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
  // The new account has its own root key, as any real account does.
  acct.pubkey = OTHER
  Keys.userPubkey = OTHER
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  acct.pubkey = ME
  Keys.userPubkey = ME
  Keys.keyCache.clear()
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  const folderKey = Crypto.generateKey()
  relay.events = [
    { kind: 30079, tags: [['d', 'f-1'], ['key', `nip44:${Crypto.bytesToHex(folderKey)}`]], content: '{"name":"f"}' },
  ]
  published.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  Keys.clearCache()
  Keys.storage = null
})

describe('an account switch mid-action writes nothing for the new account', () => {
  it('upload into a folder', async () => {
    const release = hold('wrapFileKeyForOwner')
    const run = uploadFiles([new File(['hello'], 'a.txt', { type: 'text/plain' })], { folderId: 'f-1' })
    await settle()
    await switchAccount()
    release()
    const [item] = await run
    await settle()
    expect(item.status).toBe('error')
    expect(published.filter((e) => e.by === OTHER)).toEqual([])
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })

  it('folder share', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = Sharing.encryptForRecipient.bind(Sharing)
    vi.spyOn(Sharing, 'encryptForRecipient').mockImplementation(async (...args) => {
      await gate
      return real(...args)
    })
    const tag = relay.events[0].tags.find((t) => t[0] === 'key')![1]
    const run = Sharing.shareFolder({ id: 'f-1', name: 'f', encrypted_key: tag } as never, RECIPIENT)
    await settle()
    await switchAccount()
    release()
    await expect(run).rejects.toThrow()
    await settle()
    expect(published.filter((e) => e.by === OTHER)).toEqual([])
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })

  it('share of a file in a derived folder', async () => {
    const release = hold('loadEncryptedKey')
    const run = Sharing.shareFile({ id: 'file-1', folder: 'f-2', name: 'x', sha256: 'a'.repeat(64) } as never, RECIPIENT)
    await settle()
    await switchAccount()
    release()
    await expect(run).rejects.toThrow()
    await settle()
    expect(published.filter((e) => e.by === OTHER)).toEqual([])
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })

  it('public link with tracking', async () => {
    const release = hold('loadEncryptedKey')
    const file = { id: 'file-1', folder: 'f-2', name: 'x', sha256: 'a'.repeat(64) } as never
    const run = Sharing.generatePublicLink(file, 'https://stash.test', { expiresAt: 2_000_000_000 })
    await settle()
    await switchAccount()
    release()
    await expect(run).rejects.toThrow()
    await settle()
    expect(published.filter((e) => e.by === OTHER)).toEqual([])
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })
})
