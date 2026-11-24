// cloistr-audit: shareFolder took an UNTAGGED folder's key from getFolderKey,
// skipping the unverified check that upload applies. An own folder poisoned
// before provenance existed was refused for uploads but could still be shared,
// handing the recipient the planted key. Own untagged folders now go through
// Keys.resolveOwnFolderKey; a folder whose key was shared to us (a re-share)
// is left as it was, because the resolver drops a key someone else gave us.
// Which one a folder is comes from its event's author (folder.pubkey), never
// from the stored key's sharedBy: a crafted share can set that (!244 audit).
// Real Keys + Crypto; relay and signer are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ME, MALLORY, published, relay, subscribe } = vi.hoisted(() => {
  const relay = { events: [] as Array<{ kind: number; tags: string[][]; content: string }> }
  return {
    ME: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
    MALLORY: 'e'.repeat(64),
    published: [] as Array<{ kind: number; tags: string[][] }>,
    relay,
    subscribe: vi.fn(async (..._a: unknown[]) => relay.events),
  }
})

// query: the drive-shape check finds no root ring, so this is an old-shape drive.
vi.mock('./relay', () => ({ Relay: { subscribe: (...a: unknown[]) => subscribe(...a), query: async () => [] } }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: ME }),
    publishEvent: async (e: { kind: number; tags: string[][] }) => {
      published.push(e)
    },
  },
  getSigner: () => ({}),
}))

import { Keys, FolderKeyUnverifiedError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'
import { Sharing } from './sharing'

const enc = (key: Uint8Array) => `nip44:${Crypto.bytesToHex(key)}`
const hex = (k: Uint8Array) => Crypto.bytesToHex(k)
const RECIPIENT = 'c'.repeat(64)
const shares = () => published.filter((e) => e.kind === 30080)

beforeEach(async () => {
  await Crypto.init()
  Keys.setStorage(new InMemoryKeyStorage())
  const auth: AuthPort = {
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
  Keys.configure({ auth })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  Keys.unverifiedFolders?.clear()
  published.length = 0
  relay.events = []
  subscribe.mockClear()
})

afterEach(() => {
  Keys.clearCache()
  Keys.storage = null
})

describe('sharing an untagged folder', () => {
  beforeEach(async () => {
    await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  })

  it('an own folder whose key cannot be verified is refused, in plain words, and nothing is published', async () => {
    const planted = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-mine', planted, 'f-mine') // pre-provenance, not the derived key
    const encrypt = vi.spyOn(Sharing, 'encryptForRecipient')

    const out = await Sharing.shareFolder({ id: 'f-mine', name: 'mine', pubkey: ME } as never, RECIPIENT).catch((e: unknown) => e)

    expect(out).toBeInstanceOf(FolderKeyUnverifiedError)
    expect((out as Error).message).toMatch(/cannot be shared/)
    expect((out as Error).message).not.toMatch(/upload/i)
    expect(encrypt).not.toHaveBeenCalled()
    expect(shares()).toEqual([])
    // Refused, not repaired behind the user's back: the stored key is untouched.
    Keys.keyCache.clear()
    expect(hex((await Keys.loadEncryptedKey('folder:f-mine'))!)).toBe(hex(planted))
  })

  it('an own derived folder still shares, with its derived key', async () => {
    const derived = await Keys.getFolderKey('f-derived', null)

    await Sharing.shareFolder({ id: 'f-derived', name: 'derived', pubkey: ME } as never, RECIPIENT)

    expect(shares()).toHaveLength(1)
    const sent = vi.mocked(Keys.auth!.nip44Encrypt!).mock.calls.find(([pk]) => pk === RECIPIENT)
    expect(sent?.[1]).toBe(hex(derived))
  })

  it('a folder shared to us keeps its key, and re-sharing it behaves as before', async () => {
    const theirs = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-theirs', theirs, 'f-theirs', { sharedBy: MALLORY })

    await Sharing.shareFolder({ id: 'f-theirs', name: 'theirs', pubkey: MALLORY } as never, RECIPIENT)

    Keys.keyCache.clear()
    const kept = await Keys.storage!.get(`${ME}:folder:f-theirs`)
    expect(kept?.sharedBy).toBe(MALLORY)
    expect(hex((await Keys.loadEncryptedKey('folder:f-theirs'))!)).toBe(hex(theirs))
    expect(shares()).toHaveLength(1)
    const sent = vi.mocked(Keys.auth!.nip44Encrypt!).mock.calls.find(([pk]) => pk === RECIPIENT)
    expect(sent?.[1]).toBe(hex(theirs))
  })

  it('an own folder holding a key a crafted share planted (no local key before) is refused; nothing is published', async () => {
    // What accepting the crafted share stores: the attacker's key, sharedBy the attacker.
    const planted = Crypto.generateKey()
    await Keys.storeEncryptedKey('folder:f-mine', planted, 'f-mine', { sharedBy: MALLORY })
    const encrypt = vi.spyOn(Sharing, 'encryptForRecipient')

    const out = await Sharing.shareFolder({ id: 'f-mine', name: 'mine', pubkey: ME } as never, RECIPIENT).catch((e: unknown) => e)

    expect(out).toBeInstanceOf(FolderKeyUnverifiedError)
    expect((out as Error).message).toMatch(/cannot be shared/)
    expect(encrypt).not.toHaveBeenCalled()
    expect(shares()).toEqual([])
  })

  it('a folder whose author is unknown is refused, in plain words, and nothing is published', async () => {
    const encrypt = vi.spyOn(Sharing, 'encryptForRecipient')

    const out = await Sharing.shareFolder({ id: 'f-anon', name: 'anon' } as never, RECIPIENT).catch((e: unknown) => e)

    expect(out).toBeInstanceOf(FolderKeyUnverifiedError)
    expect((out as Error).message).toMatch(/cannot be shared/)
    expect(encrypt).not.toHaveBeenCalled()
    expect(shares()).toEqual([])
  })
})
