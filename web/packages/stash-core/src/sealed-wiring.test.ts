// The app's operations pick the sealed path by the item and the drive's
// shape (sealedDrive.ts): a sealed item is always edited sealed, a new item
// follows the drive, and an unknown shape refuses before publishing anything.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { OWNER, ROOT, store } = vi.hoisted(() => ({
  OWNER: 'a'.repeat(64),
  ROOT: new Uint8Array(32).fill(1),
  store: { events: [] as Array<{ kind: number; pubkey: string; id: string; created_at: number; tags: string[][]; content: string; sig: string }>, seq: 0, rootKeyFails: false },
}))

vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: OWNER,
    signEvent: async (ev: { kind: number; created_at: number; tags: string[][]; content: string }) => ({
      ...ev,
      pubkey: OWNER,
      id: (++store.seq).toString(16).padStart(64, '0'),
      sig: '',
    }),
    publishEvent: async (ev: (typeof store.events)[number]) => {
      const d = ev.tags.find((t) => t[0] === 'd')?.[1]
      store.events = store.events.filter((e) => !(e.kind === ev.kind && d !== undefined && e.tags.find((t) => t[0] === 'd')?.[1] === d))
      store.events.push(ev)
    },
  },
  getSigner: () => ({}),
}))

vi.mock('./relay', () => ({
  Relay: {
    query: async (filters: Array<{ kinds?: number[]; '#d'?: string[] }>) =>
      store.events.filter((e) =>
        filters.some(
          (f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f['#d'] || f['#d'].includes(e.tags.find((t) => t[0] === 'd')?.[1] ?? '')),
        ),
      ),
  },
}))

vi.mock('./keys', async (orig) => {
  const real = (await orig()) as { Keys: Record<string, unknown> }
  return {
    ...real,
    Keys: Object.assign(Object.create(real.Keys), {
      getRootKey: async () => {
        if (store.rootKeyFails) throw new Error('signer unavailable')
        return ROOT
      },
      wrapFileKeyForOwner: async (_k: Uint8Array, subject: string) => `env:${subject}`,
      generateFolderKey: async () => new Uint8Array(32).fill(7),
      selfEncrypt: async () => 'self-encrypted',
    }),
  }
})

import { buildOwnDrive } from './drive'
import { addFile } from './driveWrite'
import { createFolder, renameFile } from './operations'
import { forgetDrive, rememberDrive, writeContext } from './sealedDrive'
import type { SignedEvent } from './api'

const listing = async (rootKey: Uint8Array | null = ROOT) =>
  buildOwnDrive(store.events as SignedEvent[], OWNER, rootKey)

beforeEach(() => {
  store.events = []
  store.rootKeyFails = false
  forgetDrive()
})

describe('sealed writes through the app operations', () => {
  it('a sealed file is renamed sealed: no name in the clear, and the reader sees the new name', async () => {
    rememberDrive(OWNER, await listing())
    // Seal the drive: the first sealed file creates the root ring.
    await addFile(await writeContext(), {
      key: new Uint8Array(32).fill(4),
      meta: { id: 'f'.repeat(32), name: 'before.txt', folderId: null, sha256: 'e'.repeat(64) },
    })
    let drive = await listing()
    expect(drive.shape).toBe('sealed')
    rememberDrive(OWNER, drive)

    await renameFile(drive.files[0], 'after.txt')
    drive = await listing()
    expect(drive.files.map((f) => f.name)).toEqual(['after.txt'])
    for (const ev of store.events) expect(JSON.stringify(ev)).not.toMatch(/before|after/)
  })

  it('a new folder follows the drive: sealed in a sealed drive, old shape in an old one', async () => {
    rememberDrive(OWNER, await listing())
    await createFolder('Old Shape', null)
    expect(store.events.find((e) => e.kind === 30079)!.content).toContain('Old Shape')

    store.events = []
    rememberDrive(OWNER, await listing())
    await addFile(await writeContext(), {
      key: new Uint8Array(32).fill(4),
      meta: { id: 'f'.repeat(32), name: 'x', folderId: null, sha256: 'e'.repeat(64) },
    })
    rememberDrive(OWNER, await listing())
    await createFolder('Sealed One', null)
    for (const ev of store.events) expect(JSON.stringify(ev)).not.toContain('Sealed One')
    expect((await listing()).folders.map((f) => f.name)).toEqual(['Sealed One'])
  })

  it('with the shape unknown (no root key), a new folder is refused and nothing is published', async () => {
    rememberDrive(OWNER, await listing(null))
    store.rootKeyFails = true
    await expect(createFolder('Nope', null)).rejects.toThrow('could not be read fully')
    expect(store.events).toEqual([])
  })
})
