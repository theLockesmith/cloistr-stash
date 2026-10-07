// The one place a file's decryption key is chosen for reading.
//
// A file uploaded in wrapped-key mode is encrypted with a random key, wrapped
// to the owner and stored as its `owner_key` tag; the folder-derived (HKDF)
// key does not decrypt it. Legacy files carry no owner_key and use HKDF.
// Keys.getFileKey makes that decision; this module feeds it the entry's ids
// and the signer, so no read path picks a key on its own again. (Eight did,
// and every wrapped-key upload failed "Decryption failed" until 2026-10-07.)

import { Crypto } from './crypto'
import { Keys } from './keys'
import { API } from './api'
import { getSigner } from './authBridge'

/** A file entry as the various callers hold it (relay event fields, list rows, collab refs). */
export type FileRef = Record<string, unknown> & { sha256?: string }

// `id` first: it is StashFile's canonical field and the id the migration and
// the copy path bound each owner_key envelope to; unwrap must use the same one.
export function fileIdOf(file: FileRef): string | undefined {
  return (file.id ?? file.file_id ?? file.fileId ?? file.d) as string | undefined
}

export function folderIdOf(file: FileRef): string | null {
  return ((file.folder_id ?? file.folderId ?? file.folder) as string | undefined) || null
}

/** The key that decrypts this file's blob. The caller wipes it when done. */
export async function fileKeyFor(file: FileRef): Promise<Uint8Array> {
  const fileId = fileIdOf(file)
  if (!fileId) throw new Error('Cannot decrypt: missing file ID')
  // Only a non-empty string is an envelope; anything else must not reach the signer.
  const ownerKey = typeof file.owner_key === 'string' && file.owner_key !== '' ? file.owner_key : undefined
  return Keys.getFileKey(
    folderIdOf(file),
    fileId,
    ownerKey ? { ownerEnvelope: ownerKey, signer: getSigner() } : undefined,
  )
}

export function isEncrypted(file: FileRef): boolean {
  return Boolean(file.encrypted || file.encryption)
}

/**
 * Fetch a file's blob and return its plaintext. Decrypts when the entry is
 * marked encrypted, or always with `{ encrypted: true }` (collab refs carry no flag).
 */
export async function readFileBytes(file: FileRef, opts?: { encrypted?: boolean }): Promise<Uint8Array> {
  if (!file.sha256) throw new Error('File has no content hash')
  const response = await fetch(API.getDownloadURL(file.sha256))
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const stored = await response.arrayBuffer()
  if (!(opts?.encrypted ?? isEncrypted(file))) return new Uint8Array(stored)

  const key = await fileKeyFor(file)
  try {
    return await Crypto.decryptFile(stored, key)
  } finally {
    // Always wipe, including on a decrypt failure.
    Crypto.wipeKey(key)
  }
}
