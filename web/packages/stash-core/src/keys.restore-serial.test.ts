// !229 audit: sign-in runs two folder-key restores at once, and each cleared
// every unverified flag before re-checking, so an upload could pass
// assertFolderKeyUsable for a folder that should refuse it. A flag changes only
// once that folder's new verdict is known, and restores run one at a time.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Keys, FolderKeyUnverifiedError, RestoreTimeoutError } from './keys'
import type { AuthPort } from './keys'
import { Crypto } from './crypto'
import { InMemoryKeyStorage } from './key-storage'

const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

function mockAuth(): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: vi.fn(async (_pk, pt) => `nip04:${pt}`),
    nip04Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip04:', '')),
    nip44Encrypt: vi.fn(async (_pk, pt) => `nip44:${pt}`),
    nip44Decrypt: vi.fn(async (_pk, ct) => ct.replace('nip44:', '')),
    createRootKeyEvent: vi.fn(),
    publishEvent: vi.fn(),
  }
}

beforeEach(async () => {
  await Crypto.init()
  Keys.setStorage(new InMemoryKeyStorage())
  Keys.configure({ auth: mockAuth() })
  Keys.userPubkey = ME
  Keys.nip44Writes = true
  Keys.keyCache.clear()
  Keys.unverifiedFolders.clear()
  await Keys.storeEncryptedKey('root', Crypto.generateKey(), null)
  // A pre-provenance key that is not the derived key: unverified on every load.
  await Keys.storeEncryptedKey('folder:f-odd', Crypto.generateKey(), 'f-odd')
  expect((await Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])).unverified).toEqual(['f-odd'])
})

afterEach(() => {
  vi.restoreAllMocks()
  Keys.restoreTimeoutMs = 30_000
  Keys.clearCache()
  Keys.storage = null
})

/** Holds every expectedDerivedFolderKey call until release(). */
function holdVerification() {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const real = Keys.expectedDerivedFolderKey.bind(Keys)
  const spy = vi.spyOn(Keys, 'expectedDerivedFolderKey').mockImplementation(async (...args) => {
    await gate
    return real(...args)
  })
  return { spy, release }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('folder-key restore on load', () => {
  it('never lifts an unverified flag while the folder is being re-checked', async () => {
    const { release } = holdVerification()
    const run = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])
    await settle()
    expect(() => Keys.assertFolderKeyUsable('f-odd')).toThrow(FolderKeyUnverifiedError)
    release()
    expect((await run).unverified).toEqual(['f-odd'])
    expect(() => Keys.assertFolderKeyUsable('f-odd')).toThrow(FolderKeyUnverifiedError)
  })

  it('runs one restore at a time', async () => {
    const { spy, release } = holdVerification()
    const first = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])
    const second = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])
    await settle()
    expect(spy).toHaveBeenCalledTimes(1) // the second waits for the first
    expect(() => Keys.assertFolderKeyUsable('f-odd')).toThrow(FolderKeyUnverifiedError)
    release()
    expect((await first).unverified).toEqual(['f-odd'])
    expect((await second).unverified).toEqual(['f-odd'])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a failed restore still lets the next one run', async () => {
    const spy = vi.spyOn(Keys, 'ensureStorage').mockRejectedValueOnce(new Error('storage down'))
    await expect(Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])).rejects.toThrow('storage down')
    spy.mockRestore()
    expect((await Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])).unverified).toEqual(['f-odd'])
  })

  // !233 audit: a hung signer must not stall every later restore.
  it('a hung restore times out and the next one runs', async () => {
    Keys.restoreTimeoutMs = 50
    const { spy, release } = holdVerification()
    const first = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])
    await expect(first).rejects.toBeInstanceOf(RestoreTimeoutError)
    expect(() => Keys.assertFolderKeyUsable('f-odd')).toThrow(FolderKeyUnverifiedError)
    spy.mockRestore()
    expect((await Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])).unverified).toEqual(['f-odd'])
    release()
  })

  it('a timed-out restore stops before its next folder', async () => {
    Keys.restoreTimeoutMs = 50
    const { spy, release } = holdVerification()
    await Keys.storeEncryptedKey('folder:f-two', Crypto.generateKey(), 'f-two')
    const run = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }, { id: 'f-two' }])
    await expect(run).rejects.toBeInstanceOf(RestoreTimeoutError)
    release()
    await settle()
    expect(spy).toHaveBeenCalledTimes(1) // f-two was never checked
  })

  // !233 audit: a restore queued for one account must not run after sign-out.
  it('sign-out drops queued restores', async () => {
    const { spy, release } = holdVerification()
    const first = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])
    const queued = Keys.restoreOwnFolderKeys([{ id: 'f-odd' }])
    await settle()
    Keys.clearCache()
    release()
    await first.catch(() => undefined)
    expect(await queued).toEqual({ restored: 0, repaired: 0, errors: 0, unverified: [] })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(Keys.unverifiedFolders.size).toBe(0) // the run cut short by sign-out flagged nothing
  })
})
