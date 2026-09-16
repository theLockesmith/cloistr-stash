// Upload handling with client-side encryption. Files are encrypted before
// upload; the server only ever sees the encrypted blob.
//
// PORTED from legacy/js/upload.js (uploadAll) into a typed, framework-free
// module. Pipeline per file: read -> plaintext hash (+ dup check) -> derive
// file key (folder or root) -> encrypt -> hash ciphertext (Blossom hash) ->
// upload auth -> POST blob -> publish encrypted metadata event -> wipe key.
// Search indexing is a no-op until the search module is ported (#5).

import { Crypto } from './crypto'
import { Keys } from './keys'
import { API } from './api'
import { Events } from './events'
import { authPort, getSigner } from './authBridge'
import { Relay } from './relay'
import { Search } from './search'
import type { StashFile } from '../state/types'

export type UploadStatus =
  | 'pending'
  | 'encrypting'
  | 'hashing'
  | 'uploading'
  | 'publishing'
  | 'success'
  | 'duplicate'
  | 'error'

export interface UploadItem {
  id: string
  fileId: string
  name: string
  size: number
  status: UploadStatus
  progress: number
  error: string | null
}

export interface UploadOptions {
  folderId: string | null
  /** Existing files in scope, for content-dedup (plaintext hash). */
  existing?: StashFile[]
  onItem?: (item: UploadItem) => void
}

const RELAY_UPLOAD_DELAY_MS = 500

function makeItem(file: File): UploadItem & { file: File } {
  return {
    id: crypto.randomUUID(),
    fileId: Crypto.generateFileId(),
    file,
    name: file.name,
    size: file.size,
    status: 'pending',
    progress: 0,
    error: null,
  }
}

/** Encrypt + upload a queue of files. Returns the final item states. */
export async function uploadFiles(fileList: File[], opts: UploadOptions): Promise<UploadItem[]> {
  await Crypto.init()

  const items = fileList.map(makeItem)
  const { folderId, existing = [], onItem } = opts
  const emit = (it: UploadItem) => onItem?.({ ...it })

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (i > 0) await new Promise((r) => setTimeout(r, RELAY_UPLOAD_DELAY_MS))

    try {
      const fileBuffer = await item.file.arrayBuffer()
      const fileData = new Uint8Array(fileBuffer)

      const plaintextHash = await Crypto.hash(fileData)

      const dup = existing.find(
        (f) => f.plaintext_hash === plaintextHash || f.plaintextHash === plaintextHash,
      )
      if (dup) {
        item.status = 'duplicate'
        item.error = `Duplicate of "${(dup.name as string) || dup.sha256}"`
        emit(item)
        continue
      }

      item.status = 'encrypting'
      emit(item)
      const fileKey = Keys.wrappedKeyMode
        ? Keys.generateFileKey()
        : folderId
          ? await Keys.deriveFileKey(folderId, item.fileId)
          : await Keys.deriveRootFileKey(item.fileId)

      const encryptedData = await Crypto.encryptFile(fileData, fileKey, (p) => {
        item.progress = Math.round(p * 50)
        emit(item)
      })

      item.status = 'hashing'
      emit(item)
      const encryptedHash = await Crypto.hash(encryptedData)

      item.status = 'uploading'
      emit(item)
      let authHeader: string | null = null
      if (authPort.isConnected) {
        authHeader = await authPort.createUploadAuth(encryptedHash, encryptedData.length)
      }

      const encryptedFile = new File([encryptedData as BlobPart], item.file.name + '.encrypted', {
        type: 'application/octet-stream',
      })
      const result = await API.uploadFile(encryptedFile, authHeader, 'e2e')
      const sha256 = (result.sha256 as string) || encryptedHash

      if (authPort.isConnected) {
        item.status = 'publishing'
        emit(item)

        let ownerEnvelope: string | undefined
        if (Keys.wrappedKeyMode) {
          const signer = getSigner()
          ownerEnvelope = await Keys.wrapFileKeyForOwner(fileKey, item.fileId, signer)

          if (folderId) {
            await addWrappedKeyToFolder(folderId, item.fileId, fileKey)
          }
        }

        const metadataEvent = await Events.createEncryptedFileMetadataEvent({
          fileId: item.fileId,
          sha256,
          plaintextHash,
          name: item.file.name,
          size: item.file.size,
          encryptedSize: encryptedData.length,
          mimeType: item.file.type || 'application/octet-stream',
          folderId: folderId ?? undefined,
          ownerEnvelope,
        })
        await authPort.publishEvent(metadataEvent)
      }

      // Index the plaintext for encrypted search (best-effort) before wiping.
      try {
        await Search.indexFile(
          {
            file_id: item.fileId,
            sha256,
            name: item.file.name,
            size: item.file.size,
            mime_type: item.file.type,
            encrypted: true,
          },
          fileData,
        )
      } catch (err) {
        console.warn('Upload: failed to index file for search', err)
      }

      Crypto.wipeKey(fileKey)
      item.status = 'success'
      item.progress = 100
      emit(item)
    } catch (err) {
      item.status = 'error'
      item.error = (err as Error).message
      console.error(`Upload failed for ${item.name}:`, err)
      emit(item)
    }
  }

  // Strip the File handle from returned items.
  return items.map(({ file: _file, ...rest }) => rest)
}

/**
 * Encrypt a raw Uint8Array and upload it as an encrypted file.
 *
 * This is the analog of the legacy `Upload.uploadEncryptedFile(data, name, mimeType, folderId)`
 * that was referenced — but never defined — in the migration flow. The pipeline is the same as
 * `uploadFiles` but accepts an already-buffered Uint8Array rather than a browser File object.
 *
 * Used by the migration flow to re-encrypt plaintext blobs in place.
 */
export async function uploadEncryptedBytes(
  data: Uint8Array,
  name: string,
  mimeType: string,
  folderId?: string | null,
): Promise<void> {
  await Crypto.init()

  const fileId = Crypto.generateFileId()
  const plaintextHash = await Crypto.hash(data)

  const fileKey = Keys.wrappedKeyMode
    ? Keys.generateFileKey()
    : folderId
      ? await Keys.deriveFileKey(folderId, fileId)
      : await Keys.deriveRootFileKey(fileId)

  const encryptedData = await Crypto.encryptFile(data, fileKey)
  const encryptedHash = await Crypto.hash(encryptedData)

  let authHeader: string | null = null
  if (authPort.isConnected) {
    authHeader = await authPort.createUploadAuth(encryptedHash, encryptedData.length)
  }

  const encryptedFile = new File([encryptedData as BlobPart], name + '.encrypted', {
    type: 'application/octet-stream',
  })
  const result = await API.uploadFile(encryptedFile, authHeader, 'e2e')
  const sha256 = (result.sha256 as string) || encryptedHash

  if (authPort.isConnected) {
    let ownerEnvelope: string | undefined
    if (Keys.wrappedKeyMode) {
      const signer = getSigner()
      ownerEnvelope = await Keys.wrapFileKeyForOwner(fileKey, fileId, signer)
      if (folderId) {
        await addWrappedKeyToFolder(folderId, fileId, fileKey)
      }
    }

    const metadataEvent = await Events.createEncryptedFileMetadataEvent({
      fileId,
      sha256,
      plaintextHash,
      name,
      size: data.length,
      encryptedSize: encryptedData.length,
      mimeType: mimeType || 'application/octet-stream',
      folderId: folderId ?? undefined,
      ownerEnvelope,
    })
    await authPort.publishEvent(metadataEvent)
  }

  Crypto.wipeKey(fileKey)
}

/**
 * Copy a file to a different folder.
 *
 * Because every file is encrypted with a key derived from (root-or-folder-key,
 * fileId), a copy is not a metadata-only operation: the ciphertext produced by
 * the source key cannot be decrypted with the destination key. The pipeline is:
 *   1. Fetch the encrypted blob via the Blossom download URL.
 *   2. Derive the source file key (source folderId + fileId).
 *   3. Decrypt to plaintext.
 *   4. Call uploadEncryptedBytes, which assigns a new fileId, re-encrypts under
 *      the destination key, uploads, and publishes a new metadata event.
 *   5. Wipe both keys.
 *
 * The original file is not modified.
 */
async function addWrappedKeyToFolder(
  folderId: string,
  fileId: string,
  fileKey: Uint8Array,
): Promise<void> {
  const pubkey = authPort.pubkey
  if (!pubkey) return

  const folderKey = await Keys.getFolderKey(folderId)
  const envelope = Keys.wrapFileKeyForFolder(fileKey, fileId, folderKey)

  // Query the current folder event to preserve existing wrapped keys
  const events = await Relay.subscribe(
    { kinds: [30079], authors: [pubkey], '#d': [folderId], limit: 1 },
    5000,
  )

  const existingWrapped: Array<{ subject: string; envelope: string }> = []
  let folderName = ''
  let folderDescription = ''
  let parentId: string | undefined
  let encryptedFolderKey: string | undefined

  if (events.length > 0) {
    const event = events[0]
    for (const tag of (event.tags ?? []) as string[][]) {
      if (tag[0] === 'wk' && tag.length >= 3) {
        existingWrapped.push({ subject: tag[1], envelope: tag[2] })
      } else if (tag[0] === 'key' && tag.length >= 2) {
        encryptedFolderKey = tag[1]
      } else if (tag[0] === 'parent' && tag.length >= 2) {
        parentId = tag[1]
      }
    }
    try {
      const content = JSON.parse(event.content as string) as Record<string, unknown>
      folderName = (content.name as string) ?? ''
      folderDescription = (content.description as string) ?? ''
    } catch { /* use defaults */ }
  }

  // Replace or add this file's wrapped key
  const updated = existingWrapped.filter((wk) => wk.subject !== fileId)
  updated.push({ subject: fileId, envelope })

  if (!encryptedFolderKey) {
    const folderKeyHex = Crypto.bytesToHex(folderKey)
    encryptedFolderKey = await Keys.selfEncrypt(pubkey, folderKeyHex)
  }

  const folderEvent = await Events.createEncryptedFolderEvent({
    id: folderId,
    name: folderName,
    description: folderDescription,
    parentId,
    encryptedFolderKey,
    wrappedKeys: updated,
  })
  await authPort.publishEvent(folderEvent)
}

export async function copyFile(
  file: StashFile,
  targetFolderId: string | null,
): Promise<void> {
  await Crypto.init()

  // Extract source file identity using the same multi-alias pattern as the
  // rest of the codebase (server returns various field names).
  const f = file as Record<string, unknown>
  const fileId = (file.id ?? f.file_id ?? f.fileId ?? f.d) as string | undefined
  const sourceFolderId = (f.folder_id ?? f.folderId ?? file.folder ?? null) as string | null

  if (!fileId) throw new Error('Cannot copy: file has no ID')
  if (!file.sha256) throw new Error('Cannot copy: file has no sha256')

  // 1. Fetch the encrypted blob.
  const downloadUrl = API.getDownloadURL(file.sha256)
  const response = await fetch(downloadUrl)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const encryptedBuffer = await response.arrayBuffer()

  // 2. Get source key and decrypt (wrapped key → derivation fallback).
  const sourceKey = await Keys.getFileKey(sourceFolderId, fileId, {
    ownerEnvelope: file.owner_key,
    signer: getSigner(),
  })

  const plaintext = await Crypto.decryptFile(encryptedBuffer, sourceKey)
  Crypto.wipeKey(sourceKey)

  // 3. Re-encrypt under a fresh fileId in the target folder and upload.
  const name = file.name
  const mimeType = (file.mime_type ?? 'application/octet-stream') as string
  await uploadEncryptedBytes(plaintext, name, mimeType, targetFolderId)
}