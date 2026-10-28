// The web app's file listing: the owner's whole drive from the relay in one
// REQ by author and kind, cut into folder levels locally. Replaces /api/files
// and /api/folders (drive interop Phase 1). Goes through this device's drive
// index (stash-core driveIndex), so a load fetches only what changed.
//
// One page load asks from the file list, the folder tree and the views at
// once, so calls share the read already running for that account, but only
// while nothing has been published since it began (a refresh after a write
// must see the write) and the account has not signed out since (S1).
import type { DriveSnapshot } from '@cloistr/stash-core/drive'
import { defaultDriveIndexStore, driveIndexGeneration, loadOwnDriveIndexed } from '@cloistr/stash-core/driveIndex'
import { Keys } from '@cloistr/stash-core/keys'
import { Relay } from '@cloistr/stash-core/relay'
import { getSigner } from '@cloistr/stash-core/authBridge'
import { rememberDrive } from '@cloistr/stash-core/sealedDrive'
import type { StashFile, StashFolder } from './types'

const indexStore = defaultDriveIndexStore()
const running = new Map<string, { epoch: string; drive: Promise<DriveSnapshot> }>()

export function fetchDrive(pubkey: string): Promise<DriveSnapshot> {
  const epoch = `${Relay.published}:${driveIndexGeneration(pubkey)}`
  const had = running.get(pubkey)
  if (had && had.epoch === epoch) return had.drive
  const drive = readDrive(pubkey).finally(() => {
    if (running.get(pubkey)?.drive === drive) running.delete(pubkey)
  })
  running.set(pubkey, { epoch, drive })
  return drive
}

async function readDrive(pubkey: string): Promise<DriveSnapshot> {
  const generation = driveIndexGeneration(pubkey)
  // Without the root key, old-shape files still list; sealed ones come back
  // in `unreadable` (the signer may be down; that must not empty the drive).
  let rootKey: Uint8Array | null = null
  try {
    rootKey = await Keys.getRootKey()
  } catch (err) {
    console.warn('fetchDrive: root key unavailable, listing old-shape items only -', (err as Error).message)
  }
  const drive = await loadOwnDriveIndexed((filters) => Relay.query(filters), pubkey, rootKey, {
    store: indexStore,
    // A file whose ring entry was lost still reaches its owner (one signer call each).
    unwrapOwner: (envelope, d) => Keys.unwrapFileKeyFromOwner(envelope, d, getSigner()),
  })
  if (drive.unreadable.length) console.warn('fetchDrive: unreadable items', drive.unreadable)
  // Writes take their shape and their keys from this listing; not from one
  // begun before a sign-out.
  if (driveIndexGeneration(pubkey) === generation) rememberDrive(pubkey, drive)
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
