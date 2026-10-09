// File/folder mutation operations, ported from app.js (moveToTrash, bulkDelete
// folder branch). Deletes are soft for files (re-publish encrypted metadata
// with deletedAt) and a batched kind:5 (NIP-09) event for folders.

import { Events } from './events'
import { authPort, getSigner } from './authBridge'
import { editOwnEvent, setTag } from './editEvent'
import { Keys } from './keys'
import { fileKeyFor } from './fileKey'
import { Crypto } from './crypto'
import type { StashFile, StashFolder } from './types'

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Throttle between relay publishes (relay rate-limits unknown pubkeys ~5/s). */
export const RELAY_THROTTLE_MS = 250

export function fileIdOf(file: StashFile): string {
  return (file.id ||
    (file.file_id as string) ||
    (file.fileId as string) ||
    (file.d as string) ||
    file.sha256) as string
}

export { EventUnavailableError as FileEventUnavailableError } from './editEvent'

interface FileEdit {
  name?: string
  /** '' or null moves to the root. */
  folderId?: string | null
  /** null clears it (restore). */
  deletedAt?: number | null
  userTags?: string[]
  ownerEnvelope?: string
}

/** Re-publish a file's CURRENT relay event with one change (see editEvent.ts). */
async function editFileEvent(file: StashFile, edit: FileEdit): Promise<void> {
  const fileId = fileIdOf(file)
  if (!fileId) throw new Error('Cannot edit: file has no ID')
  await editOwnEvent(30078, fileId, (draft) => {
    if (edit.name !== undefined) draft.content.name = edit.name
    if (edit.folderId !== undefined) setTag(draft, 'folder', edit.folderId || null)
    if (edit.deletedAt !== undefined) {
      if (edit.deletedAt === null) delete draft.content.deleted_at
      else draft.content.deleted_at = edit.deletedAt
      setTag(draft, 'deleted_at', edit.deletedAt === null ? null : String(edit.deletedAt))
    }
    if (edit.userTags !== undefined) {
      draft.tags = draft.tags.filter((t) => t[0] !== 't')
      for (const t of edit.userTags) if (t.trim()) draft.tags.push(['t', t.trim().toLowerCase()])
    }
    if (edit.ownerEnvelope !== undefined) setTag(draft, 'owner_key', edit.ownerEnvelope)
  })
}

/** Soft-delete a file: re-publish its current event with deletedAt set. */
export async function softDeleteFile(file: StashFile): Promise<void> {
  await editFileEvent(file, { deletedAt: Math.floor(Date.now() / 1000) })
}

/** Delete folders with a single batched kind:5 deletion event. */
export async function deleteFolders(folderIds: string[]): Promise<void> {
  if (folderIds.length === 0) return
  const event = await Events.createBatchDeleteEvent([], folderIds)
  await authPort.publishEvent(event)
}

/** Rename a file: re-publish its current event with a new name. */
export async function renameFile(file: StashFile, newName: string): Promise<void> {
  if (!newName || newName === file.name) return
  await editFileEvent(file, { name: newName })
}

/**
 * Move a file: re-publish its current event with a new folder id ('' = root).
 * A legacy file has no owner_key and its key is derived from the folder it is
 * in, so moving it would change the key it is read with. Such a file first
 * gets its current key wrapped to the owner (owner_key), which is read first
 * from then on, wherever the file lives.
 */
export async function moveFile(file: StashFile, targetFolderId: string): Promise<void> {
  const fileId = fileIdOf(file)
  if (!fileId) throw new Error('Cannot move: file has no ID')
  await editOwnEvent(30078, fileId, async (draft) => {
    const has = (name: string) => draft.tags.some((t) => t[0] === name && !!t[1])
    const fromFolder = draft.tags.find((t) => t[0] === 'folder')?.[1] || ''
    if (has('encrypted') && !has('owner_key') && (targetFolderId || '') !== fromFolder) {
      const key = await fileKeyFor({ id: fileId, folder: fromFolder || undefined })
      try {
        setTag(draft, 'owner_key', (await Keys.wrapFileKeyForOwner(key, fileId, getSigner())) as unknown as string)
      } finally {
        Crypto.wipeKey(key)
      }
    }
    setTag(draft, 'folder', targetFolderId || null)
  })
}

/**
 * Restore a file from trash: re-publish its current event WITHOUT deletedAt,
 * so the file reappears in My Files.
 */
export async function restoreFile(file: StashFile): Promise<void> {
  await editFileEvent(file, { deletedAt: null })
}

/**
 * Permanently delete a file: publish a kind:5 NIP-09 deletion event for its
 * metadata event. Mirrors the legacy permanentDelete() at app.js:3178.
 */
export async function permanentDeleteFile(file: StashFile): Promise<void> {
  const fileId = fileIdOf(file)
  if (!fileId) throw new Error('Cannot permanently delete: file has no ID')
  const event = await Events.createBatchDeleteEvent([fileId], [])
  await authPort.publishEvent(event)
}

/**
 * Set tags on a file: re-publish its current event with the new tag list.
 * Existing tags are replaced entirely. Pass [] to clear all tags.
 */
export async function setFileTags(file: StashFile, tags: string[]): Promise<void> {
  await editFileEvent(file, { userTags: tags })
}

/**
 * Rename a folder: re-publish its CURRENT relay event with a new name. Every
 * tag is kept, including the folder key ('key') and the wrapped file keys
 * ('wk') that rebuilding the event from the list row used to drop.
 */
export async function renameFolder(folder: StashFolder, newName: string): Promise<void> {
  if (!newName || newName === folder.name) return
  await editOwnEvent(30079, folder.id, (draft) => {
    draft.content.name = newName
  })
}
