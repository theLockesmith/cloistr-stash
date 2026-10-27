// Found live 2026-10-27: permanent deletes left every encrypted blob in
// Blossom. Empty Trash is the batch form of the same delete, so it must delete
// the trashed files' blobs too, after the kind 5 for their records.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROVIDER = readFileSync(join(__dirname, 'StashProvider.tsx'), 'utf8')

function callback(name: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  return PROVIDER.slice(start, PROVIDER.indexOf('\n  const ', start + 1))
}

describe('Empty Trash', () => {
  it('deletes the trashed blobs after publishing the deletion of their records', () => {
    const body = callback('emptyTrash')
    const blobsAt = body.indexOf('deleteFileBlobs(trashFiles)')
    expect(blobsAt, 'Empty Trash never deletes the blobs').toBeGreaterThan(-1)
    expect(blobsAt).toBeGreaterThan(body.indexOf('publishEvent(event)'))
  })

  it('says so when a blob stays behind, rather than calling the delete a failure', () => {
    for (const name of ['emptyTrash', 'permanentDeleteFile']) {
      expect(callback(name), name).toContain('err instanceof BlobDeleteError')
    }
  })
})
