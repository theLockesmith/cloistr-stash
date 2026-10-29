// cloistr-audit on !238: an account switch stops a revoke-and-re-encrypt
// partway, which is the safe direction, but nothing said so. Once the new copy
// is published and before the old blob is gone, people the file was shared
// with can still open the old copy, so a half-done revoke must never read as
// done. The revoke now throws RevokeIncompleteError naming how far it got,
// keeps that record, and Sharing.retryRevoke finishes it, only for the account
// that started it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, OTHER, acct, published, calls, gate, holdAt, relay, drive } = vi.hoisted(() => ({
  ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  OTHER: 'b'.repeat(64),
  acct: {
    pubkey: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
  },
  published: [] as Array<{ kind: number; by: string; a: string[]; tags?: string[][]; content?: string }>,
  calls: {
    upload: 0,
    del: 0,
    notices: 0,
    deleted: [] as string[],
    sealedDeleted: [] as string[],
  },
  // What the relay holds, by event id; `metadata` makes the new record's publish
  // fail after landing ('lost') or without landing ('dropped').
  relay: {
    events: new Map<string, { id: string; kind: number }>(),
    n: 0,
    metadata: 'ok' as 'ok' | 'lost' | 'dropped',
  },
  drive: {
    sealed: false,
    added: [] as Array<{ id: string; name: string; folderId: string | null }>,
    // Makes the sealed add throw before it signs anything, as wrapForOwner does on an account switch.
    failBeforeSign: null as Error | null,
  },
  holdAt: { step: 'upload' as 'upload' | 'delete' | 'notice' | 'record' },
  // The first Blossom auth signature waits here, as a NIP-46 round trip does.
  gate: {
    held: null as Promise<void> | null,
    release: () => {},
    signed: false,
  },
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

vi.mock('./relay', () => ({
  Relay: {
    subscribe: async () => [],
    query: async (filters: Array<{ ids?: string[] }>) =>
      filters.flatMap((f) => (f.ids ?? []).flatMap((id) => (relay.events.has(id) ? [relay.events.get(id)] : []))),
  },
}))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    get pubkey() {
      return acct.pubkey
    },
    createUploadAuth: async () => (holdAt.step === 'upload' ? signBlossom() : 'Nostr x'),
    createDeleteAuth: async () => 'Nostr x',
    signEvent: async (e: { kind: number; tags?: string[][] }) => {
      // The revoke signs its blob removal (24242) here, then the share-record
      // removals (5 naming 30080), then the old file record's removal (5 naming 30078).
      const names = (k: string) => (e.tags ?? []).some((t) => t[0] === 'a' && t[1].startsWith(k))
      if (
        (holdAt.step === 'delete' && e.kind === 24242) ||
        (holdAt.step === 'notice' && e.kind === 5 && names('30080:')) ||
        (holdAt.step === 'record' && e.kind === 5 && names('30078:'))
      )
        await signBlossom()
      return { ...e, id: `id-${++relay.n}`, sig: 'sig', pubkey: acct.pubkey }
    },
    publishEvent: async (e: { id: string; kind: number; tags?: string[][] }) => {
      if (e.kind === 30078 && relay.metadata === 'dropped') throw new Error('publish timed out')
      relay.events.set(e.id, e)
      if (e.kind === 30078 && relay.metadata === 'lost') throw new Error('publish timed out')
      const a = (e.tags ?? []).filter((t) => t[0] === 'a').map((t) => t[1])
      if (e.kind === 5 && a.some((x) => x.startsWith('30080:'))) calls.notices++
      published.push({
        kind: e.kind,
        by: acct.pubkey,
        a,
        tags: e.tags ?? [],
        content: (e as { content?: string }).content,
      })
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
vi.mock('./sealedDrive', () => ({
  writesSealed: async () => drive.sealed,
  writeContext: async () => ({}),
}))
vi.mock('./driveWrite', () => ({
  // As the real one: the sealed file event (kind 30078, no plaintext tags), then the ring.
  addFile: async (
    ctx: { publish: (e: unknown) => Promise<unknown> },
    args: { meta: { id: string; name: string; folderId: string | null } },
  ) => {
    if (drive.failBeforeSign) throw drive.failBeforeSign
    drive.added.push(args.meta)
    await ctx.publish({
      kind: 30078,
      created_at: 1,
      tags: [
        ['d', `d-${args.meta.id}`],
        ['q', 'q'],
      ],
      content: 'sealed',
    })
    await ctx.publish({ kind: 30079, created_at: 1, tags: [['d', 'ring']], content: 'ring' })
    return { d: `d-${args.meta.id}`, id: args.meta.id, key: new Uint8Array(32) }
  },
  deleteFile: async (_ctx: unknown, ref: { d: string }) => {
    calls.sealedDeleted.push(ref.d)
  },
}))
vi.mock('./versioning', () => ({
  Versioning: { getVersionHistory: async () => [] },
}))

import { Keys, AccountChangedError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { Sharing, RevokeIncompleteError } from './sharing'

const settle = () => new Promise((r) => setTimeout(r, 20))
const OLD = 'a'.repeat(64)
const FILE = {
  id: 'file-1',
  file_id: 'file-1',
  sha256: OLD,
  name: 'r.txt',
} as never

function setAccount(pk: string) {
  Keys.clearCache()
  acct.pubkey = pk
  Keys.userPubkey = pk
}

/** Start a revoke, switch account at `step`, then let that signature return. */
async function revokeSwitchingAt(step: 'upload' | 'delete' | 'notice' | 'record', file = FILE): Promise<unknown> {
  holdAt.step = step
  gate.held = new Promise<void>((r) => (gate.release = r))
  gate.signed = false
  const run = Sharing.revokeAndReencryptFile(file).catch((e: unknown) => e)
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
  relay.events.clear()
  relay.metadata = 'ok'
  drive.sealed = false
  drive.added.length = 0
  drive.failBeforeSign = null
  Object.assign(calls, {
    upload: 0,
    del: 0,
    notices: 0,
    deleted: [],
    sealedDeleted: [],
  })
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
    expect(pending).toMatchObject({
      stage: 'old-copy-remains',
      pubkey: ME,
      fileId: 'file-1',
      oldSha256: OLD,
    })
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

// Orchestrator ruling on !239: a finished revoke left the OLD file's metadata
// record (kind 30078 under the old file id) listed beside the new copy, naming
// a blob that is gone. Withdrawing it is now the last stage of the revoke, so a
// stop there is reported and retried like the others.
const RECORD = `30078:${ME}:file-1`
const recordDeletions = () => published.filter((e) => e.kind === 5 && e.a.includes(RECORD))

describe('a finished revoke withdraws the old file record', () => {
  it('a completed revoke publishes a deletion of the old record, under the starting account', async () => {
    await Sharing.revokeAndReencryptFile(FILE)
    expect(recordDeletions().map(({ kind, by, a }) => ({ kind, by, a }))).toEqual([{ kind: 5, by: ME, a: [RECORD] }])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('the new copy is never named in the deletion', async () => {
    const result = await Sharing.revokeAndReencryptFile(FILE)
    expect(published.some((e) => e.kind === 5 && e.a.some((a) => a.endsWith(`:${result.newFileId}`)))).toBe(false)
  })

  it('a sealed old file is removed through the sealed delete, by its d', async () => {
    const sealed = {
      ...(FILE as object),
      sealed: true,
      d: 'sealed-d-1',
      folder_id: null,
    } as never
    await Sharing.revokeAndReencryptFile(sealed)
    expect(calls.sealedDeleted).toEqual(['sealed-d-1'])
    expect(recordDeletions()).toEqual([])
  })

  it('stopped while withdrawing the old record: reported, kept, and finished on retry', async () => {
    const out = await revokeSwitchingAt('record')
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    expect((out as RevokeIncompleteError).pending.stage).toBe('old-record')
    expect(calls.deleted).toEqual([OLD])
    expect(calls.notices).toBe(1)
    expect(recordDeletions()).toEqual([])
    expect(Sharing.pendingRevoke('file-1')?.stage).toBe('old-record')

    setAccount(ME)
    await Sharing.retryRevoke(FILE)
    expect(recordDeletions().map(({ kind, by, a }) => ({ kind, by, a }))).toEqual([{ kind: 5, by: ME, a: [RECORD] }])
    expect(calls.notices).toBe(1)
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('a relay failure on the old record is reported and retryable, not swallowed', async () => {
    const real = (await import('./authBridge')).authPort.publishEvent
    const spy = vi
      .spyOn((await import('./authBridge')).authPort, 'publishEvent')
      .mockImplementation(async (event: unknown) => {
        const e = event as { kind: number; tags?: string[][] }
        if (e.kind === 5 && (e.tags ?? []).some((t) => t[1] === RECORD)) throw new Error('relay rejected')
        return real(e as never)
      })
    await expect(Sharing.revokeAndReencryptFile(FILE)).rejects.toBeInstanceOf(RevokeIncompleteError)
    expect(Sharing.pendingRevoke('file-1')?.stage).toBe('old-record')
    spy.mockRestore()

    await Sharing.retryRevoke(FILE)
    expect(recordDeletions().map(({ kind, by, a }) => ({ kind, by, a }))).toEqual([{ kind: 5, by: ME, a: [RECORD] }])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })
})

// cloistr-audit on !239: a publish of the new copy's record that lands but whose
// answer is lost threw with no record kept, so the owner's next revoke made a
// second copy. Now it is kept as 'old-copy-remains' with the signed record, and
// a retry asks the relay for that record before publishing it again. The old
// blob is never removed until the new record is known to be on the relay.
const newRecords = () => published.filter((e) => e.kind === 30078)

describe('a lost answer on the new record publish', () => {
  it('landed: kept as unfinished, retry finds it and does not publish a second copy', async () => {
    relay.metadata = 'lost'
    const out = await Sharing.revokeAndReencryptFile(FILE).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    const pending = (out as RevokeIncompleteError).pending
    expect(pending.stage).toBe('old-copy-remains')
    expect(pending.newEvent?.kind).toBe(30078)
    expect(relay.events.has(pending.newEvent!.id)).toBe(true)
    expect(calls.del).toBe(0)

    relay.metadata = 'ok'
    const uploads = calls.upload
    const result = await Sharing.retryRevoke(FILE)
    expect(newRecords()).toHaveLength(0)
    expect(calls.upload).toBe(uploads)
    expect(calls.deleted).toEqual([OLD])
    expect(result.newFileId).toBe(pending.newFileId)
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('never landed: retry publishes that same record once, then finishes', async () => {
    relay.metadata = 'dropped'
    const out = await Sharing.revokeAndReencryptFile(FILE).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    const id = (out as RevokeIncompleteError).pending.newEvent!.id
    expect(relay.events.has(id)).toBe(false)
    expect(calls.del).toBe(0)

    relay.metadata = 'ok'
    await Sharing.retryRevoke(FILE)
    expect(newRecords()).toHaveLength(1)
    expect(relay.events.has(id)).toBe(true)
    expect(calls.deleted).toEqual([OLD])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  it('still not on the relay and the publish fails again: the old blob stays and it stays unfinished', async () => {
    relay.metadata = 'dropped'
    await Sharing.revokeAndReencryptFile(FILE).catch(() => {})
    await expect(Sharing.retryRevoke(FILE)).rejects.toBeInstanceOf(RevokeIncompleteError)
    expect(calls.del).toBe(0)
    expect(Sharing.pendingRevoke('file-1')?.stage).toBe('old-copy-remains')
  })
})

// Orchestrator ruling on !240: a revoke of a sealed file published the new
// copy as an old-shape kind 30078 with its name, size and type in the clear,
// undoing the sealing for that file. In a sealed drive, or for a sealed file,
// the new copy is now added sealed, the same way an upload adds one.
const plaintextRecords = () =>
  published.filter(
    (e) =>
      e.kind === 30078 &&
      ((e.tags ?? []).some((t) => ['name', 'm', 'size', 'ox'].includes(t[0])) || (e.content ?? '').includes('r.txt')),
  )
const SEALED = { ...(FILE as object), sealed: true, d: 'sealed-d-1', folder_id: null } as never

describe('a revoke never unseals a file', () => {
  it('a sealed file: the new copy is added sealed, no plaintext record is published', async () => {
    drive.sealed = true
    const result = await Sharing.revokeAndReencryptFile(SEALED)
    expect(plaintextRecords()).toEqual([])
    expect(drive.added).toEqual([expect.objectContaining({ id: result.newFileId, name: 'r.txt', folderId: null })])
    expect(calls.sealedDeleted).toEqual(['sealed-d-1'])
  })

  it('a sealed file even when the drive check says otherwise: still sealed', async () => {
    drive.sealed = false
    await Sharing.revokeAndReencryptFile(SEALED)
    expect(plaintextRecords()).toEqual([])
    expect(drive.added).toHaveLength(1)
  })

  it('an old-shape file in a sealed drive: the new copy is sealed too', async () => {
    drive.sealed = true
    await Sharing.revokeAndReencryptFile(FILE)
    expect(plaintextRecords()).toEqual([])
    expect(drive.added).toHaveLength(1)
  })

  it('a lost answer on the sealed record: kept with that record, retry finds it, no second copy', async () => {
    drive.sealed = true
    relay.metadata = 'lost'
    const out = await Sharing.revokeAndReencryptFile(SEALED).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    const pending = (out as RevokeIncompleteError).pending
    expect(pending.stage).toBe('old-copy-remains')
    expect(pending.newEvent?.kind).toBe(30078)
    expect(calls.del).toBe(0)

    relay.metadata = 'ok'
    await Sharing.retryRevoke(SEALED)
    expect(drive.added).toHaveLength(1)
    // One sealed record on the relay: the one that landed, never a second.
    expect([...relay.events.values()].filter((e) => e.kind === 30078)).toHaveLength(1)
    expect(published.filter((e) => e.kind === 30078)).toHaveLength(0)
    expect(calls.deleted).toEqual([OLD])
    expect(plaintextRecords()).toEqual([])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })

  // cloistr-audit on !241: a failure inside the sealed add before its record is
  // signed was recorded as 'old-copy-remains' with no record, so Retry removed
  // the old blob while no new copy existed: the file was lost.
  it('stopped before the sealed record is signed: the old blob is kept, retry re-runs it', async () => {
    drive.sealed = true
    drive.failBeforeSign = new AccountChangedError()
    const out = await Sharing.revokeAndReencryptFile(SEALED).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(RevokeIncompleteError)
    expect((out as RevokeIncompleteError).pending.stage).toBe('not-started')
    expect(calls.del).toBe(0)

    // Still failing on retry: the old blob stays and nothing claims a new copy.
    const again = await Sharing.retryRevoke(SEALED).catch((e: unknown) => e)
    expect(again).toBeInstanceOf(RevokeIncompleteError)
    expect(calls.del).toBe(0)
    expect(calls.sealedDeleted).toEqual([])

    drive.failBeforeSign = null
    await Sharing.retryRevoke(SEALED)
    expect(drive.added).toHaveLength(1)
    expect(calls.deleted).toEqual([OLD])
    expect(Sharing.pendingRevoke('file-1')).toBeNull()
  })
})
