// File/folder mutation operations, ported from app.js (moveToTrash, bulkDelete
// folder branch). Deletes are soft for files (re-publish encrypted metadata
// with deletedAt) and a batched kind:5 (NIP-09) event for folders.

import { Events } from './events'
import { authPort } from './authBridge'
import type { StashFile, StashFolder } from '../state/types'

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

// Build the encrypted-file metadata input common to rename/move (re-publish
// preserving every field except the one being changed).
function fileMetaBase(file: StashFile) {
  return {
    fileId: fileIdOf(file),
    sha256: file.sha256,
    plaintextHash: (file.plaintext_hash || file.plaintextHash) as string | undefined,
    name: file.name,
    size: file.size,
    encryptedSize: (file.encrypted_size || file.encryptedSize) as number | undefined,
    mimeType: file.mime_type,
    folderId: (file.folder_id || file.folderId || file.folder) as string | undefined,
    deletedAt: (file.deleted_at || file.deletedAt) as number | undefined,
  }
}

/** Rename a file: re-publish its metadata with a new name. */
export async function renameFile(file: StashFile, newName: string): Promise<void> {
  if (!newName || newName === file.name) return
  const event = await Events.createEncryptedFileMetadataEvent({ ...fileMetaBase(file), name: newName })
  await authPort.publishEvent(event)
}

/** Move a file: re-publish its metadata with a new folder id ('' = root). */
export async function moveFile(file: StashFile, targetFolderId: string): Promise<void> {
  const event = await Events.createEncryptedFileMetadataEvent({
    ...fileMetaBase(file),
    folderId: targetFolderId,
  })
  await authPort.publishEvent(event)
}

/** Rename a folder: re-publish its event with a new name. Uses the encrypted
 *  folder event when a folder key is present so the 'key' tag is preserved
 *  (legacy used createFolderEvent here, which dropped the key). */
export async function renameFolder(folder: StashFolder, newName: string): Promise<void> {
  if (!newName || newName === folder.name) return
  const encryptedFolderKey = (folder.encrypted_key || folder.encryptedFolderKey) as string | undefined
  const input = {
    id: folder.id,
    name: newName,
    description: (folder.description as string) || '',
    parentId: (folder.parent_id || folder.parentId) as string | undefined,
    encryptedFolderKey,
  }
  const event = encryptedFolderKey
    ? await Events.createEncryptedFolderEvent(input)
    : await Events.createFolderEvent(input)
  await authPort.publishEvent(event)
}
