import { beforeAll, describe, expect, it } from 'vitest'
import { Crypto } from './crypto'
import { Keys } from './keys'

beforeAll(async () => {
  await Crypto.init()
})

describe('Crypto: XChaCha20-Poly1305 single-shot', () => {
  it('round-trips arbitrary bytes', () => {
    const key = Crypto.generateKey()
    const plaintext = new TextEncoder().encode('the quick brown fox 🦊')
    const ct = Crypto.encrypt(plaintext, key)
    // layout: nonce(24) || ciphertext || tag(16)
    expect(ct.length).toBe(Crypto.NONCE_LENGTH + plaintext.length + Crypto.TAG_LENGTH)
    const pt = Crypto.decrypt(ct, key)
    expect(new TextDecoder().decode(pt)).toBe('the quick brown fox 🦊')
  })

  it('fails to decrypt with the wrong key', () => {
    const ct = Crypto.encrypt(new TextEncoder().encode('secret'), Crypto.generateKey())
    expect(() => Crypto.decrypt(ct, Crypto.generateKey())).toThrow(/Decryption failed/)
  })

  it('round-trips strings and JSON', () => {
    const key = Crypto.generateKey()
    expect(Crypto.decryptString(Crypto.encryptString('héllo', key), key)).toBe('héllo')
    const obj = { a: 1, b: ['x', 'y'], c: { nested: true } }
    expect(Crypto.decryptJSON(Crypto.encryptJSON(obj, key), key)).toEqual(obj)
  })

  it('rejects keys of the wrong length', () => {
    expect(() => Crypto.encrypt(new Uint8Array([1, 2, 3]), new Uint8Array(16))).toThrow(/Invalid key length/)
  })
})

describe('Crypto: chunked CLCH container', () => {
  it('round-trips a multi-chunk payload', async () => {
    const key = Crypto.generateKey()
    // 6MB > 5MB CHUNK_SIZE => 2 chunks. Deterministic pattern fill.
    const size = 6 * 1024 * 1024
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = i & 0xff

    const enc = await Crypto.encryptChunked(data, key)
    expect(Crypto.isChunkedData(enc)).toBe(true)

    const dec = await Crypto.decryptChunked(enc, key)
    expect(dec.length).toBe(size)
    // spot-check boundaries rather than 6M comparisons
    expect(dec[0]).toBe(0)
    expect(dec[Crypto.CHUNK_SIZE - 1]).toBe((Crypto.CHUNK_SIZE - 1) & 0xff)
    expect(dec[Crypto.CHUNK_SIZE]).toBe(Crypto.CHUNK_SIZE & 0xff)
    expect(dec[size - 1]).toBe((size - 1) & 0xff)
  })

  it('encryptFile routes large input through the chunked path', async () => {
    const key = Crypto.generateKey()
    const data = new Uint8Array(Crypto.CHUNKED_THRESHOLD + 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff
    const enc = await Crypto.encryptFile(data, key)
    expect(Crypto.isChunkedData(enc)).toBe(true)
    const dec = await Crypto.decryptFile(enc, key)
    expect(dec.length).toBe(data.length)
    expect(dec[data.length - 1]).toBe(((data.length - 1) * 7) & 0xff)
  })
})

describe('Crypto: encodings', () => {
  it('round-trips base64url', () => {
    const bytes = Crypto.generateKey()
    expect(Crypto.base64urlToBytes(Crypto.bytesToBase64url(bytes))).toEqual(bytes)
  })

  it('round-trips hex', () => {
    const bytes = Crypto.generateKey()
    expect(Crypto.hexToBytes(Crypto.bytesToHex(bytes))).toEqual(bytes)
  })
})

describe('Keys: backward-compat anchors (must NOT change)', () => {
  it('preserves IndexedDB + HKDF context strings', () => {
    expect(Keys.DB_NAME).toBe('cloistr-drive-keys')
    expect(Keys.CONTEXT_ROOT).toBe('cloistr-drive-root-v1')
    expect(Keys.CONTEXT_FOLDER).toBe('cloistr-drive-folder-v1')
    expect(Keys.CONTEXT_FILE).toBe('cloistr-drive-file-v1')
    expect(Keys.CONTEXT_SHARE).toBe('cloistr-drive-share-v1')
  })
})

describe('Keys: HKDF derivation', () => {
  it('is deterministic and 32 bytes', async () => {
    const ikm = Crypto.generateKey()
    const a = await Keys.deriveKey(ikm, 'folder-123', Keys.CONTEXT_FOLDER)
    const b = await Keys.deriveKey(ikm, 'folder-123', Keys.CONTEXT_FOLDER)
    expect(a.length).toBe(32)
    expect(a).toEqual(b)
  })

  it('separates by context and by info', async () => {
    const ikm = Crypto.generateKey()
    const folder = await Keys.deriveKey(ikm, 'id-1', Keys.CONTEXT_FOLDER)
    const file = await Keys.deriveKey(ikm, 'id-1', Keys.CONTEXT_FILE)
    const otherInfo = await Keys.deriveKey(ikm, 'id-2', Keys.CONTEXT_FOLDER)
    expect(folder).not.toEqual(file)
    expect(folder).not.toEqual(otherInfo)
  })
})
