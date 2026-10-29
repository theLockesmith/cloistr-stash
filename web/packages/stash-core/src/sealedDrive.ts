// The signed-in user's drive as last listed, kept so that writes know which
// shape to write and can find the keys a sealed write needs (a sealed item's
// key comes only from its container's ring). Whoever lists the drive calls
// rememberDrive with the snapshot; the web app does it in fetchDrive.
//
// Which shape: a sealed item is always edited sealed. A NEW item (upload,
// copy, new folder) follows the drive: sealed once its root ring exists,
// old shape before (the migration, behind its flag, creates the root ring).
// With the shape unknown (no root key), new items are refused.

import { authPort, getSigner } from './authBridge'
import { loadOwnDrive, type DriveShape, type DriveSnapshot } from './drive'
import type { ItemRef, WriteContext } from './driveWrite'
import { Keys } from './keys'
import { Relay } from './relay'
import type { StashFile, StashFolder } from './types'

let current: { pubkey: string; snap: DriveSnapshot } | null = null

export function rememberDrive(pubkey: string, snap: DriveSnapshot): void {
  current = { pubkey, snap }
}

export function forgetDrive(): void {
  current = null
}

export class DriveShapeUnknownError extends Error {
  constructor() {
    super('Your drive could not be read fully (is your signer connected?). Nothing was changed; try again.')
    this.name = 'DriveShapeUnknownError'
  }
}

/** The shape new items are written in, for the signed-in user. */
export function driveShape(): DriveShape {
  if (!current || current.pubkey !== authPort.pubkey) return 'unknown'
  return current.snap.shape
}

/**
 * True when new items go out sealed; throws when that cannot be known.
 * Without a usable listing (a headless caller, or the signer was down when
 * the app listed), lists the whole drive now, the same way the app does, so
 * the shape is decided on the same evidence (see DriveSnapshot.shape).
 */
export async function writesSealed(): Promise<boolean> {
  let shape = driveShape()
  if (shape === 'unknown') {
    const pubkey = authPort.pubkey
    if (!pubkey) throw new DriveShapeUnknownError()
    try {
      const rootKey = await Keys.getRootKey()
      const snap = await loadOwnDrive((f) => Relay.query(f), pubkey, rootKey)
      rememberDrive(pubkey, snap)
      shape = snap.shape
    } catch {
      throw new DriveShapeUnknownError()
    }
  }
  if (shape === 'unknown') throw new DriveShapeUnknownError()
  return shape === 'sealed'
}

export function isSealedItem(item: StashFile | StashFolder): boolean {
  return item.sealed === true
}

/** Write context for the signed-in user, with the folder keys from the last listing. */
// Bound to the account signed in when it is made: once that account changes,
// its signing ports refuse, so a write that outlives a switch publishes nothing.
export async function writeContext(): Promise<WriteContext> {
  const pubkey = authPort.pubkey
  if (!current || !pubkey || current.pubkey !== pubkey) throw new DriveShapeUnknownError()
  const fence = Keys.accountFence() ?? undefined
  const { folderKeys } = current.snap
  const rootKey = await Keys.getRootKey()
  Keys.assertAccount(fence)
  return {
    pubkey,
    query: (filters) => Relay.query(filters),
    publish: async (ev) => {
      Keys.assertAccount(fence)
      const signed = await authPort.signEvent(ev)
      Keys.assertAccount(fence)
      await authPort.publishEvent(signed)
      return signed
    },
    wrapForOwner: async (key, subject) => {
      Keys.assertAccount(fence)
      const envelope = (await Keys.wrapFileKeyForOwner(key, subject, getSigner())) as unknown as string
      Keys.assertAccount(fence)
      return envelope
    },
    rootKey,
    folderKeys,
  }
}

/** A sealed file's ring reference (d, id, key) from the last listing. */
export function fileRef(file: StashFile): ItemRef {
  const key = file.id ? current?.snap.fileKeys.get(file.id) : undefined
  if (!file.d || !file.id || !key) throw new Error('This file is not in the loaded drive; reload and try again.')
  return { d: file.d as string, id: file.id, key }
}

/** A sealed folder's ring reference from the last listing. */
export function folderRef(folderId: string): ItemRef {
  const folder = current?.snap.folders.find((f) => f.id === folderId && f.sealed)
  const key = current?.snap.folderKeys.get(folderId)
  if (!folder?.d || !key) throw new Error('This folder is not in the loaded drive; reload and try again.')
  return { d: folder.d as string, id: folderId, key }
}

/** Everything under a sealed folder in the last listing, for deleting it whole. */
export function subtreeOf(folderId: string): { folders: ItemRef[]; files: ItemRef[] } {
  const snap = current?.snap
  if (!snap) return { folders: [], files: [] }
  const folders: ItemRef[] = []
  const ids = new Set([folderId])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of snap.folders) {
      if (f.sealed && f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
        ids.add(f.id)
        folders.push(folderRef(f.id))
        grew = true
      }
    }
  }
  const files = snap.files.filter((f) => f.sealed && ids.has((f.folder_id as string) || '')).map(fileRef)
  return { folders, files }
}

/** A sealed file's key from the last listing (a copy; the caller wipes it), or undefined. */
export function sealedFileKey(file: Record<string, unknown>): Uint8Array | undefined {
  if (file.sealed !== true || typeof file.id !== 'string') return undefined
  const key = current?.snap.fileKeys.get(file.id)
  return key ? new Uint8Array(key) : undefined
}

/** A sealed folder from the last listing, or undefined (not loaded, or old shape). */
export function sealedFolder(folderId: string): StashFolder | undefined {
  return current?.snap.folders.find((f) => f.id === folderId && f.sealed === true)
}
