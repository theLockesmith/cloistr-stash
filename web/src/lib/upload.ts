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
import { authPort } from './authBridge'
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
      const fileKey = folderId
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
        const metadataEvent = await Events.createEncryptedFileMetadataEvent({
          fileId: item.fileId,
          sha256,
          plaintextHash,
          name: item.file.name,
          size: item.file.size,
          encryptedSize: encryptedData.length,
          mimeType: item.file.type || 'application/octet-stream',
          folderId: folderId ?? undefined,
        })
        await authPort.publishEvent(metadataEvent)
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
