// One-time migration from HKDF-derived keys to envelope-wrapped keys.
//
// Phase 1 (this file): derive each existing file key one final time, wrap it
// into the folder event (symmetric, under the folder key) and into the file
// event (asymmetric, to the owner's pubkey). No blobs are re-encrypted.
//
// After this runs, the lookup path switches from "derive" to "unwrap from
// event, fall back to derive for any events the migration missed."

import { Keys } from './keys'
import { Crypto } from './crypto'
import { API } from './api'
import { Events } from './events'
import { Relay } from './relay'
import { authPort, getSigner } from './authBridge'
import type { StashFile, StashFolder } from './types'

const MIGRATION_KEY_PREFIX = 'cloistr-drive-wrapped-key-migration'
const MIGRATION_D_TAG = 'wrapped-key-migration'
const MIGRATION_VERSION = 1

function migrationKey(pubkey: string): string {
  return `${MIGRATION_KEY_PREFIX}:${pubkey}`
}

interface MigrationRecord {
  version: number
  completedAt: number
  filesMigrated: number
  foldersMigrated: number
  failedFileIds?: string[]
}

// localStorage is a per-browser CACHE of the relay record. Headless clients
// (plain Node) have none; the relay record is then the only source, which is
// the point of publishing it there.
function localCache(): Storage | null {
  try {
    return typeof localStorage === 'undefined' || !localStorage ? null : localStorage
  } catch {
    return null
  }
}

function getLocalMigrationRecord(pubkey: string): MigrationRecord | null {
  try {
    const raw = localCache()?.getItem(migrationKey(pubkey)) ?? null
    return raw ? (JSON.parse(raw) as MigrationRecord) : null
  } catch {
    return null
  }
}

async function getRelayMigrationRecord(pubkey: string): Promise<MigrationRecord | null> {
  try {
    const events = await Relay.subscribe(
      { kinds: [30078], authors: [pubkey], '#d': [MIGRATION_D_TAG], limit: 1 },
      10_000,
    )
    if (events.length === 0) return null

    const event = events[0] as { content?: string; pubkey?: string }
    if (!event.content) return null

    const decrypted = await Keys.selfDecrypt(pubkey, event.content)
    const record = JSON.parse(decrypted) as MigrationRecord

    // Cache to localStorage for fast access next time
    localCache()?.setItem(migrationKey(pubkey), JSON.stringify(record))
    return record
  } catch {
    return null
  }
}

async function saveMigrationRecord(pubkey: string, record: MigrationRecord): Promise<void> {
  localCache()?.setItem(migrationKey(pubkey), JSON.stringify(record))

  try {
    const encrypted = await Keys.selfEncrypt(pubkey, JSON.stringify(record))
    const event = await authPort.signEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', MIGRATION_D_TAG]],
      content: encrypted,
    })
    await authPort.publishEvent(event)
  } catch (err) {
    console.warn('Failed to publish migration record to relay:', (err as Error).message)
  }
}

export async function isMigrationComplete(pubkey: string): Promise<boolean> {
  const local = getLocalMigrationRecord(pubkey)
  if (local !== null && local.version >= MIGRATION_VERSION) return true

  const relay = await getRelayMigrationRecord(pubkey)
  return relay !== null && relay.version >= MIGRATION_VERSION
}

export async function runWrappedKeyMigration(): Promise<MigrationRecord | null> {
  if (!authPort.isConnected || !authPort.pubkey) return null
  const pubkey = authPort.pubkey!
  if (await isMigrationComplete(pubkey)) {
    Keys.wrappedKeyMode = true
    return null
  }

  const signer = getSigner()

  console.log('WrappedKeyMigration: starting...')

  const [{ folders }, { files: allFiles }] = await Promise.all([
    API.listFolders(pubkey),
    API.listFiles(pubkey),
  ])

  const typedFolders = folders as unknown as StashFolder[]
  const typedFiles = allFiles as unknown as StashFile[]

  const visibleFiles = typedFiles.filter(
    (f) => f.sha256 && f.sha256.length >= 16 && f.encrypted,
  )

  let filesMigrated = 0
  let foldersMigrated = 0
  const failedFileIds: string[] = []

  // Group files by folder
  const filesByFolder = new Map<string, StashFile[]>()
  for (const file of visibleFiles) {
    const folderId = (file.folder_id ?? file.folderId ?? file.folder ?? '') as string
    const list = filesByFolder.get(folderId) ?? []
    list.push(file)
    filesByFolder.set(folderId, list)
  }

  // Migrate each folder's files
  for (const folder of typedFolders) {
    const folderFiles = filesByFolder.get(folder.id) ?? []
    if (folderFiles.length === 0) {
      // Re-publish folder event preserving existing tags (no wrapped keys needed)
      foldersMigrated++
      continue
    }

    const folderKey = await Keys.resolveOwnFolderKey(folder.id, folder.encrypted_key, folder.parent_id ?? null)
    const wrappedKeys: Array<{ subject: string; envelope: string }> = []

    for (const file of folderFiles) {
      const fileId = (file.id ?? file.file_id ?? file.fileId ?? file.d) as string
      if (!fileId) continue
      if (file.owner_key) continue

      try {
        // Derive the file key one final time
        const fileKey = await Keys.deriveFileKey(folder.id, fileId)

        // Wrap under the folder key (symmetric)
        const folderEnvelope = Keys.wrapFileKeyForFolder(fileKey, fileId, folderKey)
        wrappedKeys.push({ subject: fileId, envelope: folderEnvelope })

        // Wrap to the owner (asymmetric) and re-publish the file event
        const ownerEnvelope = await Keys.wrapFileKeyForOwner(fileKey, fileId, signer)

        const metaEvent = await Events.createEncryptedFileMetadataEvent({
          fileId,
          sha256: file.sha256,
          plaintextHash: (file.plaintext_hash ?? file.plaintextHash) as string | undefined,
          name: file.name,
          size: file.size,
          encryptedSize: (file.encrypted_size ?? file.encryptedSize) as number | undefined,
          mimeType: file.mime_type,
          folderId: folder.id,
          deletedAt: (file.deleted_at ?? file.deletedAt) as number | undefined,
          userTags: file.tags ?? [],
          ownerEnvelope,
        })
        await authPort.publishEvent(metaEvent)

        Crypto.wipeKey(fileKey)
        filesMigrated++
      } catch (err) {
        console.warn('WrappedKeyMigration: failed to migrate file', fileId, err)
        failedFileIds.push(fileId)
      }
    }

    // Re-publish the folder event with wrapped keys
    const folderKeyHex = Crypto.bytesToHex(folderKey)
    const encryptedFolderKey = await Keys.selfEncrypt(pubkey, folderKeyHex)

    const folderEvent = await Events.createEncryptedFolderEvent({
      id: folder.id,
      name: folder.name,
      description: folder.description ?? '',
      parentId: folder.parent_id ?? undefined,
      encryptedFolderKey,
      wrappedKeys,
    })
    await authPort.publishEvent(folderEvent)
    foldersMigrated++
  }

  // Migrate root-level files (no folder)
  const rootFiles = filesByFolder.get('') ?? []
  for (const file of rootFiles) {
    const fileId = (file.id ?? file.file_id ?? file.fileId ?? file.d) as string
    if (!fileId) continue
    if (file.owner_key) continue

    try {
      const fileKey = await Keys.deriveRootFileKey(fileId)
      const ownerEnvelope = await Keys.wrapFileKeyForOwner(fileKey, fileId, signer)

      const metaEvent = await Events.createEncryptedFileMetadataEvent({
        fileId,
        sha256: file.sha256,
        plaintextHash: (file.plaintext_hash ?? file.plaintextHash) as string | undefined,
        name: file.name,
        size: file.size,
        encryptedSize: (file.encrypted_size ?? file.encryptedSize) as number | undefined,
        mimeType: file.mime_type,
        folderId: undefined,
        deletedAt: (file.deleted_at ?? file.deletedAt) as number | undefined,
        userTags: file.tags ?? [],
        ownerEnvelope,
      })
      await authPort.publishEvent(metaEvent)

      Crypto.wipeKey(fileKey)
      filesMigrated++
    } catch (err) {
      console.warn('WrappedKeyMigration: failed to migrate root file', fileId, err)
      failedFileIds.push(fileId)
    }
  }

  const record: MigrationRecord = {
    version: MIGRATION_VERSION,
    completedAt: Date.now(),
    filesMigrated,
    foldersMigrated,
    failedFileIds: failedFileIds.length > 0 ? failedFileIds : undefined,
  }

  if (failedFileIds.length > 0) {
    console.warn(
      `WrappedKeyMigration: incomplete. ${filesMigrated} files migrated, ${failedFileIds.length} failed. Will retry on next run.`,
    )
    return record
  }

  await saveMigrationRecord(pubkey, record)
  Keys.wrappedKeyMode = true

  console.log(
    `WrappedKeyMigration: complete. ${filesMigrated} files, ${foldersMigrated} folders.`,
  )

  return record
}
