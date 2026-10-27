// Found live 2026-10-27: permanent deletes left every encrypted blob in
// Blossom. Empty Trash is the batch form of the same delete, so it must go
// through permanentDeleteFiles, which deletes each record the way its shape
// needs (sealed records are not reached by a kind 5) and then their blobs.
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
  it('deletes records and blobs through permanentDeleteFiles, not its own kind 5', () => {
    const body = callback('emptyTrash')
    expect(body, 'Empty Trash never deletes the blobs').toContain('opPermanentDeleteFiles(trashFiles)')
    expect(body).not.toContain('createBatchDeleteEvent')
  })

  it('says so when a blob stays behind, rather than calling the delete a failure', () => {
    for (const name of ['emptyTrash', 'permanentDeleteFile']) {
      expect(callback(name), name).toContain('err instanceof BlobDeleteError')
    }
  })
})
