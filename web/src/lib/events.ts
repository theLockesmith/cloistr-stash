// Nostr metadata event builders for Stash.
//
// PORTED VERBATIM from the event-construction helpers in legacy/js/auth.js
// (createFileMetadataEvent, createEncryptedFileMetadataEvent, createFolderEvent,
// createEncryptedFolderEvent, createFolderDeleteEvent, createBatchDeleteEvent,
// generateFolderId). Tag layouts and kinds are wire-compatible with existing
// data: files = kind 30078, folders = kind 30079, deletions = kind 5 (NIP-09).
//
// The legacy global `Auth` (signEvent + pubkey) is replaced by the shared
// auth bridge port. Root-key event construction lives in authBridge.ts.

import { authPort } from './authBridge'
import type { SignedEvent } from './api'

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function requirePubkey(): string {
  if (!authPort.isConnected || !authPort.pubkey) {
    throw new Error('Not connected')
  }
  return authPort.pubkey
}

export interface FileMetadataInput {
  name: string
  size: number
  mimeType?: string
  sha256: string
  url?: string
  folderId?: string
}

export interface EncryptedFileMetadataInput {
  fileId: string
  sha256: string
  name: string
  size?: number
  encryptedSize?: number
  mimeType?: string
  plaintextHash?: string
  folderId?: string
  deletedAt?: number
  version?: number
}

export interface FolderMetadataInput {
  id: string
  name: string
  description?: string
  parentId?: string
  encryptedFolderKey?: string
}

export const Events = {
  // Unencrypted file metadata (kind 30078) — legacy.
  async createFileMetadataEvent(fileInfo: FileMetadataInput): Promise<SignedEvent> {
    const content = JSON.stringify({
      name: fileInfo.name,
      size: fileInfo.size,
      mime_type: fileInfo.mimeType,
    })

    const tags: string[][] = [
      ['d', fileInfo.sha256],
      ['x', fileInfo.sha256],
      ['m', fileInfo.mimeType || 'application/octet-stream'],
      ['size', fileInfo.size.toString()],
    ]
    if (fileInfo.url) tags.push(['url', fileInfo.url])
    if (fileInfo.folderId) tags.push(['folder', fileInfo.folderId])

    return authPort.signEvent({ kind: 30078, created_at: now(), tags, content })
  },

  // Encrypted file metadata (kind 30078) — contains all info to decrypt/identify.
  async createEncryptedFileMetadataEvent(fileInfo: EncryptedFileMetadataInput): Promise<SignedEvent> {
    if (!fileInfo.fileId) {
      throw new Error('fileId is required for encrypted file metadata')
    }
    const ts = now()

    const contentObj: Record<string, unknown> = {
      name: fileInfo.name,
      size: fileInfo.size,
      encrypted_size: fileInfo.encryptedSize,
      mime_type: fileInfo.mimeType,
      encrypted: true,
    }
    if (fileInfo.deletedAt) contentObj.deleted_at = fileInfo.deletedAt
    const content = JSON.stringify(contentObj)

    const tags: string[][] = [
      ['d', fileInfo.fileId],
      ['x', fileInfo.sha256],
      ['m', fileInfo.mimeType || 'application/octet-stream'],
      ['size', String(fileInfo.size || 0)],
      ['encrypted', 'xchacha20-poly1305'],
    ]
    if (fileInfo.plaintextHash) tags.push(['ox', fileInfo.plaintextHash])
    if (fileInfo.folderId) tags.push(['folder', fileInfo.folderId])
    if (fileInfo.deletedAt) tags.push(['deleted_at', fileInfo.deletedAt.toString()])

    if (fileInfo.version) {
      const pubkey = requirePubkey()
      tags.push(['v', fileInfo.sha256, fileInfo.version.toString(), ts.toString(), pubkey])
      tags.push(['current', fileInfo.sha256])
    }

    return authPort.signEvent({ kind: 30078, created_at: ts, tags, content })
  },

  // Unencrypted folder metadata (kind 30079).
  async createFolderEvent(folderInfo: FolderMetadataInput): Promise<SignedEvent> {
    const content = JSON.stringify({
      name: folderInfo.name,
      description: folderInfo.description || '',
    })
    const tags: string[][] = [['d', folderInfo.id]]
    if (folderInfo.parentId) tags.push(['parent', folderInfo.parentId])

    return authPort.signEvent({ kind: 30079, created_at: now(), tags, content })
  },

  // Encrypted folder metadata (kind 30079) — folder key encrypted to owner.
  async createEncryptedFolderEvent(folderInfo: FolderMetadataInput): Promise<SignedEvent> {
    const content = JSON.stringify({
      name: folderInfo.name,
      description: folderInfo.description || '',
      encrypted: true,
    })
    const tags: string[][] = [
      ['d', folderInfo.id],
      ['encrypted', 'true'],
    ]
    if (folderInfo.parentId) tags.push(['parent', folderInfo.parentId])
    if (folderInfo.encryptedFolderKey) tags.push(['key', folderInfo.encryptedFolderKey])

    return authPort.signEvent({ kind: 30079, created_at: now(), tags, content })
  },

  // Folder deletion (kind 5, NIP-09).
  async createFolderDeleteEvent(folderId: string): Promise<SignedEvent> {
    const pubkey = requirePubkey()
    return authPort.signEvent({
      kind: 5,
      created_at: now(),
      tags: [['a', `30079:${pubkey}:${folderId}`]],
      content: 'deleted',
    })
  },

  // Batched deletion (kind 5, NIP-09) for multiple files/folders in one event.
  async createBatchDeleteEvent(fileIds: string[] = [], folderIds: string[] = []): Promise<SignedEvent> {
    const pubkey = requirePubkey()
    if (fileIds.length === 0 && folderIds.length === 0) {
      throw new Error('No items to delete')
    }
    const tags: string[][] = []
    for (const fileId of fileIds) tags.push(['a', `30078:${pubkey}:${fileId}`])
    for (const folderId of folderIds) tags.push(['a', `30079:${pubkey}:${folderId}`])

    return authPort.signEvent({
      kind: 5,
      created_at: now(),
      tags,
      content: `deleted ${fileIds.length} files, ${folderIds.length} folders`,
    })
  },

  generateFolderId(): string {
    const array = new Uint8Array(16)
    crypto.getRandomValues(array)
    return Array.from(array)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  },
}

export type EventsModule = typeof Events
export default Events
