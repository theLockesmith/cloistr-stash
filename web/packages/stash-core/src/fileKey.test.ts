// Every read of a file blob must use the file's own key: its wrapped key
// (owner_key) when it has one, HKDF only for legacy files. Found 2026-10-07:
// eight read paths derived the HKDF key unconditionally, so any file uploaded
// in wrapped-key mode failed "Decryption failed" on download/preview/etc.
//
// Real XChaCha20 here, so a wrong key genuinely fails to decrypt.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// Saving a version merges into the file's current relay event (editEvent.ts).
vi.mock('./relay', () => ({
  Relay: { subscribe: async () => [{ kind: 30078, created_at: 1, tags: [['d', 'f']], content: '{}' }] },
}))
vi.mock('./authBridge', () => ({
  authPort: { isConnected: true, pubkey: 'owner-pubkey' },
  getSigner: () => ({ signEvent: async (e: unknown) => e }),
}))

import { Crypto } from './crypto'
import { Keys } from './keys'
import { API } from './api'
import { fileKeyFor, readFileBytes } from './fileKey'
import { getPlaintextBytes } from './publish'
import { Versioning } from './versioning'
import { Collaboration } from './collaboration'

const PLAINTEXT = new TextEncoder().encode('hello from a wrapped-key file')
let RANDOM_KEY: Uint8Array // the file's real key, recoverable only via owner_key
let HKDF_KEY: Uint8Array // what the folder derivation yields: NOT this file's key
const blobs = new Map<string, ArrayBuffer>()

const wrapped = { sha256: 'wrapped-sha', id: 'file-w', folder: 'folder-1', encrypted: true, owner_key: 'env-w', name: 'w.txt' }
const legacy = { sha256: 'legacy-sha', id: 'file-l', folder: 'folder-1', encrypted: true, name: 'l.txt' }
const legacyRoot = { sha256: 'root-sha', id: 'file-r', encrypted: true, name: 'r.txt' }
const plain = { sha256: 'plain-sha', id: 'file-p', name: 'p.txt' }

async function put(sha: string, key: Uint8Array | null) {
  const data = key ? await Crypto.encryptFile(PLAINTEXT, key) : PLAINTEXT
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
  blobs.set(sha, u8.slice().buffer)
}

beforeAll(async () => {
  await Crypto.init()
  RANDOM_KEY = Crypto.generateKey()
  HKDF_KEY = Crypto.generateKey()
})

beforeEach(async () => {
  blobs.clear()
  await put('wrapped-sha', RANDOM_KEY)
  await put('legacy-sha', HKDF_KEY)
  await put('root-sha', HKDF_KEY)
  await put('plain-sha', null)
  vi.spyOn(API, 'getDownloadURL').mockImplementation((sha: string) => `blob:${sha}`)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const b = blobs.get(String(url).replace('blob:', ''))
      return b
        ? { ok: true, status: 200, arrayBuffer: async () => b.slice(0) }
        : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    }),
  )
  // Copies: the read paths wipe the key they were handed.
  vi.spyOn(Keys, 'deriveFileKey').mockImplementation(async () => HKDF_KEY.slice())
  vi.spyOn(Keys, 'deriveRootFileKey').mockImplementation(async () => HKDF_KEY.slice())
  vi.spyOn(Keys, 'unwrapFileKeyFromOwner').mockImplementation(async (env: string) => {
    if (env !== 'env-w') throw new Error('bad envelope')
    return RANDOM_KEY.slice()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('fileKeyFor (the one resolver)', () => {
  it('unwraps owner_key for a wrapped file', async () => {
    expect(await fileKeyFor(wrapped)).toEqual(RANDOM_KEY)
  })
  it('derives HKDF for a legacy file, in a folder or at root', async () => {
    expect(await fileKeyFor(legacy)).toEqual(HKDF_KEY)
    expect(await fileKeyFor(legacyRoot)).toEqual(HKDF_KEY)
    expect(Keys.deriveFileKey).toHaveBeenCalledWith('folder-1', 'file-l')
    expect(Keys.deriveRootFileKey).toHaveBeenCalledWith('file-r')
  })
  it('accepts the legacy field aliases', async () => {
    const aliased = { sha256: 'x', file_id: 'file-w', folder_id: 'folder-1', owner_key: 'env-w' }
    expect(await fileKeyFor(aliased)).toEqual(RANDOM_KEY)
  })
  it('prefers the canonical id, the one the migration wrapped the key under', async () => {
    await fileKeyFor({ sha256: 'x', id: 'file-l', d: 'other', file_id: 'other', folder: 'folder-1' })
    expect(Keys.deriveFileKey).toHaveBeenCalledWith('folder-1', 'file-l')
  })
  it('ignores a non-string owner_key (no signer call for a malformed field)', async () => {
    await fileKeyFor({ ...legacy, owner_key: { bogus: true } })
    expect(Keys.unwrapFileKeyFromOwner).not.toHaveBeenCalled()
  })
  it('throws when the entry has no file id', async () => {
    await expect(fileKeyFor({ sha256: 'x' })).rejects.toThrow(/missing file ID/)
  })
})

describe('readFileBytes (Info download, Preview, keyboard download, collab load, publish)', () => {
  it('opens a wrapped-key file', async () => {
    expect(text(await readFileBytes(wrapped))).toBe('hello from a wrapped-key file')
  })
  it('still opens legacy HKDF files', async () => {
    expect(text(await readFileBytes(legacy))).toBe('hello from a wrapped-key file')
    expect(text(await readFileBytes(legacyRoot))).toBe('hello from a wrapped-key file')
  })
  it('returns unencrypted blobs as stored', async () => {
    expect(text(await readFileBytes(plain))).toBe('hello from a wrapped-key file')
  })
  it('publish.getPlaintextBytes opens a wrapped-key file', async () => {
    expect(text(await getPlaintextBytes(wrapped as never))).toBe('hello from a wrapped-key file')
  })
})

describe('version history', () => {
  it('reads a version of a wrapped-key file saved with its real key', async () => {
    await put('v2-sha', RANDOM_KEY)
    vi.spyOn(Versioning, 'getVersion').mockResolvedValue({ sha256: 'v2-sha', version: 2 } as never)
    expect(text(await Versioning.downloadVersion(wrapped as never, 2))).toBe('hello from a wrapped-key file')
  })
  it('still reads a version saved under the derived key before this fix', async () => {
    await put('v1-sha', HKDF_KEY)
    vi.spyOn(Versioning, 'getVersion').mockResolvedValue({ sha256: 'v1-sha', version: 1 } as never)
    expect(text(await Versioning.downloadVersion(wrapped as never, 1))).toBe('hello from a wrapped-key file')
  })
  it('wipes both keys when neither opens the version', async () => {
    await put('bad-sha', Crypto.generateKey())
    vi.spyOn(Versioning, 'getVersion').mockResolvedValue({ sha256: 'bad-sha', version: 3 } as never)
    const wiped: Uint8Array[] = []
    vi.spyOn(Crypto, 'wipeKey').mockImplementation((k: Uint8Array) => void wiped.push(k.slice()))
    await expect(Versioning.downloadVersion(wrapped as never, 3)).rejects.toThrow()
    expect(wiped).toContainEqual(RANDOM_KEY)
    expect(wiped).toContainEqual(HKDF_KEY)
  })
  it('wipes the file key when saving a version fails', async () => {
    vi.spyOn(Versioning, 'getVersionHistory').mockResolvedValue([])
    vi.spyOn(API, 'uploadFile').mockRejectedValue(new Error('upload down'))
    const wiped: Uint8Array[] = []
    vi.spyOn(Crypto, 'wipeKey').mockImplementation((k: Uint8Array) => void wiped.push(k.slice()))
    await expect(Versioning.createVersion(wrapped as never, PLAINTEXT)).rejects.toThrow()
    expect(wiped).toContainEqual(RANDOM_KEY)
  })
  it('encrypts a new version with the file real key', async () => {
    vi.spyOn(Versioning, 'getVersionHistory').mockResolvedValue([])
    let used: Uint8Array | null = null
    vi.spyOn(Crypto, 'encryptFile').mockImplementation(async (_d: unknown, k: Uint8Array) => {
      used = k.slice()
      throw new Error('stop-after-key')
    })
    await expect(Versioning.createVersion(wrapped as never, PLAINTEXT)).rejects.toThrow('stop-after-key')
    expect(used).toEqual(RANDOM_KEY)
  })
})

describe('collaboration', () => {
  it('derives the session key from the wrapped file real key', async () => {
    const seen: Uint8Array[] = []
    vi.spyOn(Keys, 'deriveKey').mockImplementation(async (k: Uint8Array) => {
      seen.push(k.slice())
      return new Uint8Array(32)
    })
    await Collaboration.deriveSessionKey(wrapped as never)
    expect(seen[0]).toEqual(RANDOM_KEY)
  })
  it('wipes the file key when session-key derivation fails', async () => {
    vi.spyOn(Keys, 'deriveKey').mockRejectedValue(new Error('hkdf down'))
    const wiped: Uint8Array[] = []
    vi.spyOn(Crypto, 'wipeKey').mockImplementation((k: Uint8Array) => void wiped.push(k.slice()))
    await expect(Collaboration.deriveSessionKey(wrapped as never)).rejects.toThrow('hkdf down')
    expect(wiped).toContainEqual(RANDOM_KEY)
  })
})
