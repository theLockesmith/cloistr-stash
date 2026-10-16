// The web app's file listing: the owner's whole drive from the relay in one
// REQ by author and kind (stash-core loadOwnDrive), cut into folder levels
// locally. Replaces /api/files and /api/folders (drive interop Phase 1).
import { loadOwnDrive, type DriveSnapshot } from '@cloistr/stash-core/drive'
import { Keys } from '@cloistr/stash-core/keys'
import { Relay } from '@cloistr/stash-core/relay'
import type { StashFile, StashFolder } from './types'

export async function fetchDrive(pubkey: string): Promise<DriveSnapshot> {
  // Without the root key, old-shape files still list; sealed ones come back
  // in `unreadable` (the signer may be down; that must not empty the drive).
  let rootKey: Uint8Array | null = null
  try {
    rootKey = await Keys.getRootKey()
  } catch (err) {
    console.warn('fetchDrive: root key unavailable, listing old-shape items only -', (err as Error).message)
  }
  const drive = await loadOwnDrive((filters) => Relay.query(filters), pubkey, rootKey)
  if (drive.unreadable.length) console.warn('fetchDrive: unreadable items', drive.unreadable)
  return drive
}

/** Files directly in `folderId` ('' = root), trashed ones left out. */
export function filesIn(drive: DriveSnapshot, folderId: string): StashFile[] {
  return drive.files.filter((f) => ((f.folder_id as string | undefined) || '') === folderId && !f.deleted_at)
}

/** Folders directly under `parentId` ('' = root). */
export function foldersIn(drive: DriveSnapshot, parentId: string): StashFolder[] {
  return drive.folders.filter((f) => (f.parent_id || '') === parentId)
}
