// Test helper for other apps (Space) and for stash-core's own tests: the
// events of a migrated (sealed) drive, built with the real codec, so a test
// can feed them to listFiles or a reader without running Stash. Not for
// production code: it holds every key in memory and signs nothing.

import { Crypto } from './crypto'
import type { UnsignedEvent } from './relay'
import {
  folderQ,
  randomD,
  rootContainerKey,
  sealFileEvent,
  sealFolderEvent,
  sealRing,
  type RingEntry,
} from './sealed'

export interface TestFile {
  name: string
  mimeType?: string
  size?: number
  sha256: string
  /** Name of a top-level folder to put it in; created on first use. */
  folder?: string
  /** In the trash since this time (seconds). */
  deletedAt?: number
}

export interface SealedDriveFixture {
  /** Unsigned events: the root ring, one ring per folder, folder events, file events. Sign them as the owner. */
  events: UnsignedEvent[]
  fileKeys: Map<string, Uint8Array>
  folderKeys: Map<string, Uint8Array>
}

/** A sealed drive holding `files`, readable with `rootKey`. */
export async function buildSealedDrive(args: { rootKey: Uint8Array; files: TestFile[] }): Promise<SealedDriveFixture> {
  await Crypto.init()
  const rootCK = await rootContainerKey(args.rootKey)
  const rootQ = await folderQ(rootCK, '')
  const events: UnsignedEvent[] = []
  const fileKeys = new Map<string, Uint8Array>()
  const folderKeys = new Map<string, Uint8Array>()
  const rootRing = { files: [] as RingEntry[], folders: [] as RingEntry[] }
  const folders = new Map<string, { entry: RingEntry; files: RingEntry[] }>()

  for (const f of args.files) {
    let container: { id: string; key: Uint8Array; files: RingEntry[] } = { id: '', key: rootCK, files: rootRing.files }
    if (f.folder) {
      let folder = folders.get(f.folder)
      if (!folder) {
        const entry = { d: randomD(), id: Crypto.generateFileId(), key: Crypto.generateKey() }
        events.push(await sealFolderEvent({ d: entry.d, q: rootQ, folderKey: entry.key, meta: { id: entry.id, name: f.folder, parentId: null } }))
        rootRing.folders.push(entry)
        folderKeys.set(entry.id, entry.key)
        folder = { entry, files: [] }
        folders.set(f.folder, folder)
      }
      container = { id: folder.entry.id, key: folder.entry.key, files: folder.files }
    }
    const entry = { d: randomD(), id: Crypto.generateFileId(), key: Crypto.generateKey() }
    events.push(
      await sealFileEvent({
        d: entry.d,
        q: await folderQ(container.key, container.id),
        fileKey: entry.key,
        meta: {
          id: entry.id,
          name: f.name,
          folderId: container.id || null,
          sha256: f.sha256,
          size: f.size,
          mimeType: f.mimeType,
          deletedAt: f.deletedAt,
        },
      }),
    )
    container.files.push(entry)
    fileKeys.set(entry.id, entry.key)
  }

  events.push(await sealRing({ folderKey: rootCK, folderId: '', files: rootRing.files, folders: rootRing.folders, tombstones: [] }))
  for (const { entry, files } of folders.values()) {
    events.push(await sealRing({ folderKey: entry.key, folderId: entry.id, files, folders: [], tombstones: [] }))
  }
  return { events, fileKeys, folderKeys }
}
