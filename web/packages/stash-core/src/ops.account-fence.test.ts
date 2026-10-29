// cloistr-audit on !235/!236: every write that starts for one account must
// stop, writing nothing, if the account switches before it finishes. Over
// NIP-46 each signer and relay round trip takes seconds, so a switch mid-action
// would otherwise publish (and store keys) as the new account. Uploads and
// shares are covered in keys.account-fence.test.ts; this covers the rest.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, OTHER, acct, published, relay, gate } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  OTHER: 'b'.repeat(64),
  acct: { pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766' },
  published: [] as Array<{ kind: number; tags: string[][]; content: string; by: string }>,
  relay: { events: [] as Array<{ kind: number; created_at: number; tags: string[][]; content: string }> },
  gate: { hold: null as Promise<void> | null },
}))

vi.mock('./relay', () => ({
  Relay: {
    subscribe: async () => {
      if (gate.hold) await gate.hold
      return relay.events
    },
    query: async () => [],
  },
}))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    get pubkey() {
      return acct.pubkey
    },
    createUploadAuth: async () => 'Nostr x',
    createDeleteAuth: async () => 'Nostr d',
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: acct.pubkey }),
    publishEvent: async (e: { kind: number; tags: string[][]; content: string }) => {
      published.push({ ...e, by: acct.pubkey })
    },
    nip04Encrypt: async (_pk: string, pt: string) => `nip04:${pt}`,
  },
  getSigner: () => ({
    getPublicKey: async () => acct.pubkey,
    nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
    nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
  }),
}))
vi.mock('./api', () => ({
  API: {
    uploadFile: vi.fn(async () => ({ sha256: 'f'.repeat(64) })),
    deleteFile: vi.fn(async () => ({})),
    getDownloadURL: (sha: string) => `https://blossom.test/${sha}`,
  },
}))
vi.mock('./search', () => ({ Search: { indexFile: async () => {} } }))

import { Keys } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { API } from './api'
import { renameFile, softDeleteFile, moveFile, createFolder, permanentDeleteFile } from './operations'
import { rememberDrive, forgetDrive, writeContext } from './sealedDrive'
import { Versioning } from './versioning'
import { Collaboration } from './collaboration'
import type { DriveSnapshot } from './drive'

const settle = () => new Promise((r) => setTimeout(r, 20))
const storedUnder = async (pk: string) => (await Keys.storage!.list(pk)).map((r) => r.keyId)
const byOther = () => published.filter((e) => e.by === OTHER)
const snap = (shape: 'sealed' | 'old'): DriveSnapshot =>
  ({ files: [], folders: [], fileKeys: new Map(), folderKeys: new Map(), unreadable: [], shape }) as never

function holdRelay(): () => void {
  let release!: () => void
  gate.hold = new Promise<void>((r) => (release = r))
  return () => {
    gate.hold = null
    release()
  }
}

function holdKeys(method: 'loadEncryptedKey' | 'getRootKey' | 'selfEncrypt'): () => void {
  let release!: () => void
  const g = new Promise<void>((r) => (release = r))
  const real = (Keys[method] as (...a: unknown[]) => Promise<unknown>).bind(Keys)
  let first = true
  vi.spyOn(Keys, method).mockImplementation((async (...args: unknown[]) => {
    if (first) {
      first = false
      await g
    }
    return real(...args)
  }) as never)
  return release
}

async function switchAccount() {
  Keys.clearCache()
  acct.pubkey = OTHER
  Keys.userPubkey = OTHER
  rememberDrive(OTHER, snap('old'))
}

/** Start `action`, switch account while it waits on `release`, then let it finish. */
async function switchMidway(action: () => Promise<unknown>, release: () => void) {
  const run = action()
  await settle()
  await switchAccount()
  release()
  const outcome = await run.then(
    () => 'resolved',
    () => 'rejected',
  )
  await settle()
  return outcome
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
  acct.pubkey = OTHER
  Keys.userPubkey = OTHER
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  acct.pubkey = ME
  Keys.userPubkey = ME
  Keys.keyCache.clear()
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  rememberDrive(ME, snap('old'))
  relay.events = [
    {
      kind: 30078,
      created_at: 1_800_000_000,
      tags: [['d', 'file-1'], ['x', 'a'.repeat(64)], ['encrypted', 'xchacha20-poly1305'], ['folder', 'f-2']],
      content: JSON.stringify({ name: 'a.txt', size: 3, encrypted: true }),
    },
  ]
  published.length = 0
  vi.mocked(API.uploadFile).mockClear()
  vi.mocked(API.deleteFile).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  gate.hold = null
  forgetDrive()
  Keys.clearCache()
  Keys.storage = null
})

const FILE = { id: 'file-1', name: 'a.txt', folder: 'f-2', sha256: 'a'.repeat(64), encrypted: true } as never

describe('an account switch mid-action writes nothing for the new account', () => {
  it('rename', async () => {
    expect(await switchMidway(() => renameFile(FILE, 'b.txt'), holdRelay())).toBe('rejected')
    expect(byOther()).toEqual([])
  })

  it('move to trash', async () => {
    expect(await switchMidway(() => softDeleteFile(FILE), holdRelay())).toBe('rejected')
    expect(byOther()).toEqual([])
  })

  it('move of a legacy file (its key is re-wrapped to the owner)', async () => {
    expect(await switchMidway(() => moveFile(FILE, 'f-3'), holdKeys('loadEncryptedKey'))).toBe('rejected')
    expect(byOther()).toEqual([])
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })

  it('sealed write: the context refuses to sign once the account changed', async () => {
    rememberDrive(ME, snap('sealed'))
    const ctx = await writeContext()
    await switchAccount()
    await expect(ctx.publish({ kind: 30078, created_at: 1, tags: [], content: '' } as never)).rejects.toThrow()
    await expect(ctx.wrapForOwner(Crypto.generateKey(), 'x')).rejects.toThrow()
    expect(byOther()).toEqual([])
  })

  it('sealed write: a context still being built refuses', async () => {
    rememberDrive(ME, snap('sealed'))
    expect(await switchMidway(() => writeContext(), holdKeys('getRootKey'))).toBe('rejected')
  })

  it('create folder', async () => {
    expect(await switchMidway(() => createFolder('new', null), holdKeys('selfEncrypt'))).toBe('rejected')
    expect(byOther()).toEqual([])
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })

  it('permanent delete', async () => {
    // Hold the delete while it builds the record's kind 5.
    let go!: () => void
    const g = new Promise<void>((r) => (go = r))
    const { Events } = await import('./events')
    const real = Events.createBatchDeleteEvent.bind(Events)
    vi.spyOn(Events, 'createBatchDeleteEvent').mockImplementation(async (...a) => {
      await g
      return real(...a)
    })
    expect(await switchMidway(() => permanentDeleteFile(FILE), go)).toBe('rejected')
    expect(byOther()).toEqual([])
    expect(API.deleteFile).not.toHaveBeenCalled()
  })

  it('version restore', async () => {
    vi.spyOn(Versioning, 'getVersionHistory').mockResolvedValue([{ sha256: 'a'.repeat(64), version: 1 }] as never)
    vi.spyOn(Versioning, 'storeVersionMeta').mockResolvedValue()
    let go!: () => void
    const g = new Promise<void>((r) => (go = r))
    vi.spyOn(Versioning, 'downloadVersion').mockImplementation(async () => {
      await g
      return new Uint8Array([1, 2, 3])
    })
    expect(await switchMidway(() => Versioning.restoreVersion(FILE, 1), go)).toBe('rejected')
    expect(byOther()).toEqual([])
    expect(API.uploadFile).not.toHaveBeenCalled()
    expect(await storedUnder(OTHER)).toEqual(['root'])
  })

  it('collaborative save after a switch', async () => {
    vi.spyOn(Versioning, 'getVersionHistory').mockResolvedValue([{ sha256: 'a'.repeat(64), version: 1 }] as never)
    vi.spyOn(Versioning, 'storeVersionMeta').mockResolvedValue()
    Collaboration.configure({
      downloadFileData: async () => null,
      createVersion: (file, data, opts) => Versioning.createVersion(file as never, data, opts).then(() => undefined),
    })
    const session = await Collaboration.startSession({ ...(FILE as object), file_id: 'file-1' } as never)
    session.yDoc.getText('content').insert(0, 'hello')
    await switchAccount()
    await expect(Collaboration.saveDocument(session)).rejects.toThrow()
    await settle()
    expect(byOther()).toEqual([])
    expect(API.uploadFile).not.toHaveBeenCalled()
    expect(await storedUnder(OTHER)).toEqual(['root'])
    await Collaboration.endSession('file-1')
  })
})
