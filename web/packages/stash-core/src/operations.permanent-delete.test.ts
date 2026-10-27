// Found live 2026-10-27: "Delete permanently" published the kind 5 for the
// file's record and left its encrypted blob in Blossom, where it kept counting
// against the owner's quota with nothing pointing at it. A permanent delete
// must also delete every blob the file points at (current and each version),
// signed as the owner, and only after the record is gone: a blob deleted
// first leaves a listed file that can never open.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ME, calls, api, sealed } = vi.hoisted(() => {
  const ME = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'
  const calls: string[] = []
  const api = { deleteFile: vi.fn(async (sha: string, auth: string) => { calls.push(`blob:${sha}:${auth}`); return {} }) }
  const sealed = { deleteFile: vi.fn(async () => { calls.push('sealed-record') }) }
  return { ME, calls, api, sealed }
})

vi.mock('./api', () => ({ API: api, default: api }))
vi.mock('./authBridge', () => ({
  authPort: {
    isConnected: true,
    pubkey: ME,
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: 'id', sig: 'sig', pubkey: ME }),
    publishEvent: async (e: { kind: number }) => { calls.push(`publish:${e.kind}`) },
    createDeleteAuth: async (sha: string) => `auth(${sha.slice(0, 4)})`,
  },
  getSigner: () => ({}),
}))
vi.mock('./driveWrite', () => ({ deleteFile: sealed.deleteFile }))
vi.mock('./sealedDrive', () => ({
  writeContext: async () => ({}),
  fileRef: (f: { id: string }) => f.id,
  folderRef: (id: string) => id,
  sealedFolder: () => null,
  subtreeOf: () => [],
  writesSealed: async () => true,
}))

import { BlobDeleteError, deleteFileBlobs, permanentDeleteFile } from './operations'
import type { StashFile } from './types'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

beforeEach(() => {
  calls.length = 0
  api.deleteFile.mockClear()
  sealed.deleteFile.mockClear()
})

describe('permanentDeleteFile deletes the blob too', () => {
  it('old shape: kind 5 for the record, then the blob, signed as the owner', async () => {
    await permanentDeleteFile({ id: 'f1', sha256: A, name: 'a.txt' } as StashFile)
    expect(calls).toEqual(['publish:5', `blob:${A}:auth(aaaa)`])
  })

  it('sealed: the sealed delete, then the current blob and every version blob, once each', async () => {
    const file = {
      id: 'f2', sha256: C, name: 'b.txt', sealed: true, folder_id: 'dir',
      versions: [{ sha256: A, version: 1 }, { sha256: B, version: 2 }, { sha256: C, version: 3 }],
    } as unknown as StashFile
    await permanentDeleteFile(file)
    expect(calls[0]).toBe('sealed-record')
    expect(calls.slice(1).sort()).toEqual([`blob:${A}:auth(aaaa)`, `blob:${B}:auth(bbbb)`, `blob:${C}:auth(cccc)`])
  })

  it('a record that fails to delete keeps its blob', async () => {
    sealed.deleteFile.mockRejectedValueOnce(new Error('relay down'))
    await expect(permanentDeleteFile({ id: 'f3', sha256: A, name: 'c', sealed: true } as unknown as StashFile)).rejects.toThrow('relay down')
    expect(api.deleteFile).not.toHaveBeenCalled()
  })

  it('a blob that will not delete is reported, after trying the rest', async () => {
    api.deleteFile.mockRejectedValueOnce(new Error('500'))
    const err = await deleteFileBlobs([
      { sha256: A, name: 'x' } as StashFile,
      { sha256: B, name: 'y' } as StashFile,
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlobDeleteError)
    expect((err as BlobDeleteError).sha256s).toEqual([A])
    expect(api.deleteFile).toHaveBeenCalledTimes(2)
  })

  it('skips anything that is not a blob hash', async () => {
    await deleteFileBlobs([{ sha256: '', name: 'no blob' } as StashFile, { sha256: 'file-id-not-hash', name: 'z' } as StashFile])
    expect(api.deleteFile).not.toHaveBeenCalled()
  })
})
