// File/folder mutation operations, ported from app.js (moveToTrash, bulkDelete
// folder branch). Deletes are soft for files (re-publish encrypted metadata
// with deletedAt) and a batched kind:5 (NIP-09) event for folders.

import { Events } from './events'
import { authPort } from './authBridge'
import type { StashFile } from '../state/types'

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Throttle between relay publishes (relay rate-limits unknown pubkeys ~5/s). */
export const RELAY_THROTTLE_MS = 250

function fileIdOf(file: StashFile): string {
  return (file.id ||
    (file.file_id as string) ||
    (file.fileId as string) ||
    (file.d as string) ||
    file.sha256) as string
}

/** Soft-delete a file: re-publish its encrypted metadata with deletedAt set. */
export async function softDeleteFile(file: StashFile): Promise<void> {
  const fileId = fileIdOf(file)
  if (!fileId) throw new Error('Cannot delete: file has no ID')

  const event = await Events.createEncryptedFileMetadataEvent({
    fileId,
    sha256: file.sha256,
    plaintextHash: (file.plaintext_hash || file.plaintextHash) as string | undefined,
    name: file.name,
    size: file.size,
    encryptedSize: (file.encrypted_size || file.encryptedSize) as number | undefined,
    mimeType: file.mime_type,
    folderId: (file.folder_id || file.folderId || file.folder) as string | undefined,
    deletedAt: Math.floor(Date.now() / 1000),
  })
  await authPort.publishEvent(event)
}

/** Delete folders with a single batched kind:5 deletion event. */
export async function deleteFolders(folderIds: string[]): Promise<void> {
  if (folderIds.length === 0) return
  const event = await Events.createBatchDeleteEvent([], folderIds)
  await authPort.publishEvent(event)
}
