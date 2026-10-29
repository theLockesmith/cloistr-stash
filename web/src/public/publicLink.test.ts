import { beforeAll, describe, expect, it } from 'vitest'
import { Crypto } from '@cloistr/stash-core/crypto'
import { openPublicLink, parsePublicLink } from './publicLink'

const HASH = 'ab'.repeat(32)

beforeAll(async () => {
  await Crypto.init()
})

function fakeServer(blob: Uint8Array | null, meta: Record<string, unknown> | null = null) {
  const urls: string[] = []
  const fetchFn = async (url: string) => {
    urls.push(url)
    if (url === `/api/public/${HASH}`) {
      return { ok: !!meta, status: meta ? 200 : 404, json: async () => meta, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    if (url === `/api/files/${HASH}/download`) {
      return {
        ok: !!blob,
        status: blob ? 200 : 404,
        json: async () => ({}),
        arrayBuffer: async () => (blob ? blob.slice().buffer : new ArrayBuffer(0)),
      }
    }
    throw new Error(`unexpected request ${url}`)
  }
  return { fetchFn, urls }
}

async function encrypted(plain: Uint8Array) {
  const key = Crypto.generateKey()
  const blob = await Crypto.encryptFile(plain, key)
  return { key, blob: new Uint8Array(blob as ArrayBuffer | Uint8Array) }
}

describe('parsePublicLink', () => {
  it('reads the hash from the path and the key from the fragment', async () => {
    const key = Crypto.generateKey()
    const p = parsePublicLink(`/public/${HASH}`, `#${Crypto.bytesToBase64url(key)}`)
    expect(p.ok && p.link.sha256).toBe(HASH)
    expect(p.ok && Array.from(p.link.key)).toEqual(Array.from(key))
  })

  it.each([
    [`/public/${HASH.toUpperCase()}`, '#x', 'bad-path'],
    [`/public/${HASH}x`, '#x', 'bad-path'],
    ['/public/abc', '#x', 'bad-path'],
    [`/public/${HASH}`, '', 'no-key'],
    [`/public/${HASH}`, '#', 'no-key'],
    [`/public/${HASH}`, '#AAAA', 'bad-key'],
  ])('%s %s -> %s', (path, frag, reason) => {
    expect(parsePublicLink(path, frag)).toEqual({ ok: false, reason })
  })
})

describe('openPublicLink', () => {
  it('decrypts a file Stash encrypted, with its name and type', async () => {
    const plain = new TextEncoder().encode('hello from a share link')
    const { key, blob } = await encrypted(plain)
    const { fetchFn } = fakeServer(blob, { name: 'note.txt', mime_type: 'text/plain' })
    const out = await openPublicLink({ sha256: HASH, key }, fetchFn)
    expect(new TextDecoder().decode(out.bytes)).toBe('hello from a share link')
    expect(out.name).toBe('note.txt')
    expect(out.mimeType).toBe('text/plain')
  })

  it('decrypts a chunked (large) file', async () => {
    const plain = new Uint8Array(Crypto.CHUNKED_THRESHOLD + 12345)
    for (let i = 0; i < plain.length; i += 4096) plain[i] = i & 0xff
    const { key, blob } = await encrypted(plain)
    expect(Crypto.isChunkedData(blob)).toBe(true)
    const { fetchFn } = fakeServer(blob)
    const out = await openPublicLink({ sha256: HASH, key }, fetchFn)
    expect(out.bytes.length).toBe(plain.length)
    expect(Crypto.constantTimeEqual(out.bytes, plain)).toBe(true)
    expect(out.name).toBe('download')
  })

  it('never sends the key in any request', async () => {
    const { key, blob } = await encrypted(new Uint8Array([1, 2, 3]))
    const { fetchFn, urls } = fakeServer(blob)
    await openPublicLink({ sha256: HASH, key }, fetchFn)
    const encoded = Crypto.bytesToBase64url(key)
    expect(urls.length).toBe(2)
    for (const u of urls) expect(u).not.toContain(encoded)
  })

  it('a wrong key says the link is wrong, not that the download failed', async () => {
    const { blob } = await encrypted(new Uint8Array([1, 2, 3]))
    const { fetchFn } = fakeServer(blob)
    await expect(openPublicLink({ sha256: HASH, key: Crypto.generateKey() }, fetchFn)).rejects.toThrow(/could not be decrypted/)
  })

  it('a missing blob says the file is gone', async () => {
    const { fetchFn } = fakeServer(null)
    await expect(openPublicLink({ sha256: HASH, key: Crypto.generateKey() }, fetchFn)).rejects.toThrow(/no longer available/)
  })
})
