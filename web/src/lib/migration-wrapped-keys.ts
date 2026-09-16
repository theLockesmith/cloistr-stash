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
import { authPort, getSigner } from './authBridge'
import type { StashFile, StashFolder } from '../state/types'

const MIGRATION_KEY = 'cloistr-drive-wrapped-key-migration'
const MIGRATION_VERSION = 1

interface MigrationRecord {
  version: number
  completedAt: number
  filesMigrated: number
  foldersMigrated: number
}

async function getMigrationRecord(): Promise<MigrationRecord | null> {
  try {
    const raw = localStorage.getItem(MIGRATION_KEY)
    return raw ? (JSON.parse(raw) as MigrationRecord) : null
  } catch {
    return null
  }
}

function saveMigrationRecord(record: MigrationRecord): void {
  localStorage.setItem(MIGRATION_KEY, JSON.stringify(record))
}

export async function isMigrationComplete(): Promise<boolean> {
  const record = await getMigrationRecord()
  return record !== null && record.version >= MIGRATION_VERSION
}

export async function runWrappedKeyMigration(): Promise<MigrationRecord | null> {
  if (!authPort.isConnected || !authPort.pubkey) return null
  if (await isMigrationComplete()) {
    Keys.wrappedKeyMode = true
    return null
  }

  const signer = getSigner()
  const pubkey = authPort.pubkey!

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

    const folderKey = await Keys.getFolderKey(folder.id, folder.parent_id ?? null)
    const wrappedKeys: Array<{ subject: string; envelope: string }> = []

    for (const file of folderFiles) {
      const fileId = (file.id ?? file.file_id ?? file.fileId ?? file.d) as string
      if (!fileId) continue

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
    }
  }

  const record: MigrationRecord = {
    version: MIGRATION_VERSION,
    completedAt: Date.now(),
    filesMigrated,
    foldersMigrated,
  }
  saveMigrationRecord(record)
  Keys.wrappedKeyMode = true

  console.log(
    `WrappedKeyMigration: complete. ${filesMigrated} files, ${foldersMigrated} folders.`,
  )

  return record
}
