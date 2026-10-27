// File/folder mutation operations, ported from app.js (moveToTrash, bulkDelete
// folder branch). Deletes are soft for files (re-publish encrypted metadata
// with deletedAt) and a batched kind:5 (NIP-09) event for folders.

import { API } from './api'
import { Events } from './events'
import { authPort, getSigner } from './authBridge'
import { editOwnEvent, setTag } from './editEvent'
import { Keys } from './keys'
import { fileKeyFor } from './fileKey'
import { Crypto } from './crypto'
import type { StashFile, StashFolder } from './types'
import * as Sealed from './driveWrite'
import type { SealedFileMeta } from './sealed'
import { fileRef, folderRef, sealedFolder, subtreeOf, writeContext, writesSealed } from './sealedDrive'

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

/** A sealed file: re-seal its current event with one change (driveWrite.updateFile). */
async function editSealedFile(file: StashFile, change: (m: SealedFileMeta) => SealedFileMeta): Promise<void> {
  await Sealed.updateFile(await writeContext(), fileRef(file), change)
}

/** Re-publish a file's CURRENT relay event with one change (see editEvent.ts). */
async function editFileEvent(file: StashFile, edit: FileEdit): Promise<void> {
  if (file.sealed === true) {
    return editSealedFile(file, (m) => {
      if (edit.name !== undefined) m.name = edit.name
      if (edit.folderId !== undefined) m.folderId = edit.folderId || null
      if (edit.deletedAt !== undefined) {
        if (edit.deletedAt === null) delete m.deletedAt
        else m.deletedAt = edit.deletedAt
      }
      if (edit.userTags !== undefined) m.userTags = normaliseTags(edit.userTags)
      return m
    })
  }
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
      for (const t of normaliseTags(edit.userTags)) draft.tags.push(['t', t])
    }
    if (edit.ownerEnvelope !== undefined) setTag(draft, 'owner_key', edit.ownerEnvelope)
  })
}

const normaliseTags = (tags: string[]) => tags.map((t) => t.trim().toLowerCase()).filter(Boolean)

/** Soft-delete a file: re-publish its current event with deletedAt set. */
export async function softDeleteFile(file: StashFile): Promise<void> {
  await editFileEvent(file, { deletedAt: Math.floor(Date.now() / 1000) })
}

/** Delete folders with a single batched kind:5 deletion event. */
// A sealed folder goes with its whole subtree (driveWrite.deleteFolder).
export async function deleteFolders(folderIds: string[]): Promise<void> {
  const sealed = folderIds.filter((id) => sealedFolder(id))
  if (sealed.length) {
    const ctx = await writeContext()
    for (const id of sealed) {
      await Sealed.deleteFolder(ctx, folderRef(id), sealedFolder(id)!.parent_id || null, subtreeOf(id))
    }
  }
  folderIds = folderIds.filter((id) => !sealed.includes(id))
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
  if (file.sealed === true) return editFileEvent(file, { folderId: targetFolderId || null })
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

/** A permanent delete removed the record but not every blob it pointed at. */
export class BlobDeleteError extends Error {
  constructor(readonly sha256s: string[]) {
    super(`Deleted, but ${sha256s.length} stored blob(s) could not be removed`)
    this.name = 'BlobDeleteError'
  }
}

const BLOB_HASH = /^[0-9a-f]{64}$/

/** Every blob a file points at: its current blob and each recorded version's. */
export function blobsOf(file: StashFile): string[] {
  const versions = Array.isArray(file.versions) ? (file.versions as Array<{ sha256?: string }>) : []
  return [file.sha256, ...versions.map((v) => v.sha256)].filter((s): s is string => BLOB_HASH.test(s ?? ''))
}

/**
 * Delete these files' blobs from Blossom, each signed as the owner (kind 24242
 * t=delete). Tries every blob, then throws BlobDeleteError naming the ones
 * that would not go. Call it only after the records are gone.
 */
export async function deleteFileBlobs(files: StashFile[]): Promise<void> {
  const failed: string[] = []
  for (const sha256 of new Set(files.flatMap(blobsOf))) {
    try {
      await API.deleteFile(sha256, await authPort.createDeleteAuth(sha256))
    } catch (err) {
      console.warn('deleteFileBlobs: could not delete blob', sha256.slice(0, 12), err)
      failed.push(sha256)
    }
  }
  if (failed.length > 0) throw new BlobDeleteError(failed)
}

/**
 * Permanently delete a file: delete its record (a kind:5 NIP-09 deletion, or
 * the sealed delete), then its blobs. Record first: a blob deleted before its
 * record leaves a listed file that can never open.
 */
export async function permanentDeleteFile(file: StashFile): Promise<void> {
  if (file.sealed === true) {
    await Sealed.deleteFile(await writeContext(), fileRef(file), (file.folder_id as string) || null)
  } else {
    const fileId = fileIdOf(file)
    if (!fileId) throw new Error('Cannot permanently delete: file has no ID')
    const event = await Events.createBatchDeleteEvent([fileId], [])
    await authPort.publishEvent(event)
  }
  await deleteFileBlobs([file])
}

/**
 * Permanently delete many files (Empty Trash): one kind:5 for the old-shape
 * records, the sealed delete for each sealed one (a kind:5 naming 30078:<id>
 * never reaches a sealed record), then the blobs of the files whose record
 * went. A record that will not delete keeps its blob, and its error wins.
 */
export async function permanentDeleteFiles(files: StashFile[]): Promise<void> {
  const plain = files.filter((f) => f.sealed !== true && fileIdOf(f))
  const gone: StashFile[] = []
  let recordErr: unknown
  try {
    if (plain.length > 0) {
      await authPort.publishEvent(await Events.createBatchDeleteEvent(plain.map(fileIdOf), []))
      gone.push(...plain)
    }
    for (const file of files.filter((f) => f.sealed === true)) {
      await Sealed.deleteFile(await writeContext(), fileRef(file), (file.folder_id as string) || null)
      gone.push(file)
    }
  } catch (err) {
    recordErr = err
  }
  try {
    await deleteFileBlobs(gone)
  } catch (err) {
    if (recordErr === undefined) throw err
  }
  if (recordErr !== undefined) throw recordErr
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
  if (folder.sealed === true) {
    await Sealed.updateFolder(await writeContext(), folderRef(folder.id), (m) => ({ ...m, name: newName }))
    return
  }
  await editOwnEvent(30079, folder.id, (draft) => {
    draft.content.name = newName
  })
}

/**
 * Create a folder under `parentId` (null or '' = root) and return its id. In
 * a sealed drive the key is random and wrapped in the parent's ring; in an
 * old-shape drive it is generated and self-encrypted into the folder event.
 */
export async function createFolder(name: string, parentId: string | null): Promise<string> {
  const pubkey = authPort.pubkey
  if (!authPort.isConnected || !pubkey) throw new Error('Not connected')
  const folderId = Events.generateFolderId()
  if (await writesSealed()) {
    await Sealed.createFolder(await writeContext(), { id: folderId, name: name.trim(), parentId: parentId || null })
    return folderId
  }
  const folderKey = await Keys.generateFolderKey(folderId)
  const encryptedFolderKey = await Keys.selfEncrypt(pubkey, Crypto.bytesToHex(folderKey))
  const signedEvent = await Events.createEncryptedFolderEvent({
    id: folderId,
    name: name.trim(),
    parentId: parentId || undefined,
    encryptedFolderKey,
  })
  await authPort.publishEvent(signedEvent)
  return folderId
}
