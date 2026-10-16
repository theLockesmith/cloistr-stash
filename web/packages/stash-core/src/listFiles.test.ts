// Drive interop Phase 1, step 3: the one call Space uses to list a user's
// files, old shape and sealed alike, with one REQ and the user's signer.
import { describe, it, expect } from 'vitest'
import { listFiles } from './listFiles'
import { buildSealedDrive } from './testing'
import type { SignedEvent } from './api'
import type { NostrFilter } from './relay'

const OWNER = 'a'.repeat(64)
const ROOT = new Uint8Array(32).fill(1)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// Stand-in signer: "encryption to self" is a visible prefix, so the test can
// see exactly which ciphertexts were decrypted and with which scheme.
function fakeSigner() {
  const calls: string[] = []
  return {
    calls,
    getPublicKey: async () => OWNER,
    signEvent: async () => {
      throw new Error('listing never signs')
    },
    encrypt: async (_p: string, t: string) => `nip04:${t}?iv=x`,
    decrypt: async (_p: string, c: string) => (calls.push('nip04'), c.slice('nip04:'.length, -'?iv=x'.length)),
    nip44Encrypt: async (_p: string, t: string) => `nip44:${t}`,
    nip44Decrypt: async (_p: string, c: string) => (calls.push('nip44'), c.slice('nip44:'.length)),
  }
}

let seq = 0
const signed = (ev: { kind: number; tags: string[][]; content: string; created_at?: number }): SignedEvent => ({
  ...ev,
  created_at: 1_760_000_000,
  pubkey: OWNER,
  id: (++seq).toString(16).padStart(64, '0'),
  sig: '',
})

function relayWith(events: SignedEvent[]) {
  const reqs: NostrFilter[][] = []
  return {
    reqs,
    query: async (filters: NostrFilter[]) => {
      reqs.push(filters)
      return events
    },
  }
}

const rootKeyEvent = (encrypted: string) => signed({ kind: 30078, tags: [['d', 'root-key'], ['key', encrypted]], content: '' })

const legacy = (d: string, name: string, extra: string[][] = []) =>
  signed({
    kind: 30078,
    tags: [['d', d], ['x', 'b'.repeat(64)], ['m', 'image/png'], ['size', '42'], ['encrypted', 'xchacha20-poly1305'], ...extra],
    content: JSON.stringify({ name, size: 42 }),
  })

describe('listFiles', () => {
  it('lists old-shape and sealed files with one filter (no per-folder REQs), without trashed ones', async () => {
    const sealed = await buildSealedDrive({
      rootKey: ROOT,
      files: [
        { name: 'sealed.pdf', mimeType: 'application/pdf', size: 7, sha256: 'c'.repeat(64) },
        { name: 'in-a-folder.txt', mimeType: 'text/plain', size: 3, sha256: 'd'.repeat(64), folder: 'Work' },
        { name: 'trashed.txt', size: 1, sha256: 'e'.repeat(64), deletedAt: 5 },
      ],
    })
    const relay = relayWith([
      rootKeyEvent(`nip44:${hex(ROOT)}`),
      legacy('old1', 'old.png'),
      legacy('old2', 'old-trashed.png', [['deleted_at', '9']]),
      ...sealed.events.map(signed),
    ])
    const signer = fakeSigner()
    const files = await listFiles(signer, relay, OWNER)

    // One filter by author and kind; paging repeats it once to confirm the end.
    expect(relay.reqs.length).toBeLessThanOrEqual(2)
    for (const req of relay.reqs) expect(req).toEqual([expect.objectContaining({ authors: [OWNER], kinds: [5, 30078, 30079] })])
    expect(signer.calls).toEqual(['nip44']) // the root key only, nothing per file
    expect(files.map((f) => f.name).sort()).toEqual(['in-a-folder.txt', 'old.png', 'sealed.pdf'])
    expect(files.find((f) => f.name === 'sealed.pdf')).toEqual({
      name: 'sealed.pdf',
      mimeType: 'application/pdf',
      size: 7,
      sha256: 'c'.repeat(64),
      createdAt: 1_760_000_000,
    })
    expect(files.find((f) => f.name === 'old.png')).toMatchObject({ mimeType: 'image/png', size: 42, sha256: 'b'.repeat(64) })
  })

  it('reads a root key still wrapped with NIP-04', async () => {
    const sealed = await buildSealedDrive({ rootKey: ROOT, files: [{ name: 'x.txt', size: 1, sha256: 'c'.repeat(64) }] })
    const signer = fakeSigner()
    const files = await listFiles(signer, relayWith([rootKeyEvent(`nip04:${hex(ROOT)}?iv=x`), ...sealed.events.map(signed)]), OWNER)
    expect(files.map((f) => f.name)).toEqual(['x.txt'])
    expect(signer.calls).toEqual(['nip04'])
  })

  it('without a root key event, lists old-shape files and refuses to hide that sealed ones exist', async () => {
    const sealed = await buildSealedDrive({ rootKey: ROOT, files: [{ name: 'x.txt', size: 1, sha256: 'c'.repeat(64) }] })
    await expect(listFiles(fakeSigner(), relayWith([legacy('old1', 'old.png'), ...sealed.events.map(signed)]), OWNER)).rejects.toThrow(
      /1 file could not be read/,
    )
    expect((await listFiles(fakeSigner(), relayWith([legacy('old1', 'old.png')]), OWNER)).map((f) => f.name)).toEqual(['old.png'])
  })

  it('ignores events from anyone but the owner', async () => {
    const foreign = { ...legacy('evil', 'planted.png'), pubkey: 'b'.repeat(64) }
    const files = await listFiles(fakeSigner(), relayWith([legacy('old1', 'old.png'), foreign]), OWNER)
    expect(files.map((f) => f.name)).toEqual(['old.png'])
  })
})

describe('buildSealedDrive (test helper)', () => {
  it('builds events an outsider learns nothing from', async () => {
    const { events } = await buildSealedDrive({
      rootKey: ROOT,
      files: [{ name: 'secret.pdf', mimeType: 'application/pdf', size: 7, sha256: 'c'.repeat(64), folder: 'Private' }],
    })
    for (const ev of events) {
      const clear = JSON.stringify(ev.tags) + ev.content
      for (const leak of ['secret', 'Private', 'application/pdf', 'c'.repeat(64)]) expect(clear).not.toContain(leak)
    }
  })
})
