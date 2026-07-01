// Verbatim port from legacy/js/versioning.js
// File version tracking, history, and restore for Cloistr Stash.
//
// BACKWARD-COMPATIBILITY CRITICAL: IndexedDB database name
// 'cloistr-drive-versions' and object store 'versions' are preserved
// byte-identical. Do NOT rename these — they reference existing user data.

import { Crypto } from './crypto'
import { Keys } from './keys'
import { Events } from './events'
import { API } from './api'
import { authPort } from './authBridge'

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Stored version metadata record (persisted in IndexedDB + returned from API). */
export interface FileVersion {
  /** Composite key: `${fileId}:v${version}` */
  id: string
  fileId: string
  version: number
  /** SHA-256 hex of the encrypted blob in Blossom storage. */
  sha256: string
  /** SHA-256 hex of the plaintext file content. */
  plaintextHash: string
  size: number
  encryptedSize: number
  /** Unix timestamp (seconds). */
  timestamp: number
  pubkey: string
  note: string
  autoSave: boolean
  previousVersion: string | null
}

export interface VersionCreateOptions {
  versionNote?: string
  autoSave?: boolean
}

export interface VersionComparisonResult {
  versionA: FileVersion
  versionB: FileVersion
  sizeDiff: number
  timeDiff: number
  sameContent: boolean
}

export type DiffLineType = 'unchanged' | 'added' | 'removed'

export interface DiffLine {
  type: DiffLineType
  line: string | undefined
  lineNum: number
}

/**
 * Minimal file descriptor accepted by Versioning methods.
 * Accepts both legacy field shapes (file_id, fileId, d) and the current StashFile
 * shape (id, folder) so callers can pass StashFile directly.
 */
export interface VersionableFile {
  name: string
  mime_type?: string
  mimeType?: string
  // legacy + current id fields
  file_id?: string
  fileId?: string
  d?: string
  id?: string
  // legacy + current folder fields
  folder_id?: string
  folderId?: string
  folder?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractFileId(file: VersionableFile): string {
  const id = file.file_id || file.fileId || file.d || file.id
  if (!id) throw new Error('Cannot version: missing file ID')
  return id
}

function extractFolderId(file: VersionableFile): string | null {
  return (file.folder_id || file.folderId || file.folder || null) as string | null
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const Versioning = {
  // IndexedDB identifiers (PRESERVED for backward compat — do not change)
  DB_NAME: 'cloistr-drive-versions' as const,
  DB_VERSION: 1,
  STORE_NAME: 'versions' as const,

  db: null as IDBDatabase | null,
  versionCache: new Map<string, FileVersion[]>(),

  // Initialize versioning module
  async init(): Promise<void> {
    await this.openDB()
    console.log('Versioning: Initialized')
  },

  // Open IndexedDB for version tracking
  async openDB(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION)

      request.onerror = () => reject(request.error)

      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' })
          store.createIndex('fileId', 'fileId', { unique: false })
          store.createIndex('pubkey', 'pubkey', { unique: false })
          store.createIndex('timestamp', 'timestamp', { unique: false })
        }
      }
    })
  },

  // Create a new version of a file. Returns the version metadata.
  async createVersion(
    file: VersionableFile,
    newFileData: Uint8Array | ArrayBuffer,
    options: VersionCreateOptions = {},
  ): Promise<FileVersion> {
    const { versionNote = '', autoSave = false } = options

    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    const fileId = extractFileId(file)
    const folderId = extractFolderId(file)

    // Get the current version number
    const currentVersions = await this.getVersionHistory(fileId)
    const newVersionNumber = currentVersions.length + 1

    // Derive the file encryption key
    let fileKey: Uint8Array
    if (folderId) {
      fileKey = await Keys.deriveFileKey(folderId, fileId)
    } else {
      fileKey = await Keys.deriveRootFileKey(fileId)
    }

    const encryptedData = await Crypto.encryptFile(newFileData, fileKey)
    const encryptedHash = await Crypto.hash(encryptedData)
    const plaintextHash = await Crypto.hash(
      newFileData instanceof Uint8Array ? newFileData : new Uint8Array(newFileData),
    )

    // Upload the new version blob
    const authHeader = await authPort.createUploadAuth(encryptedHash, encryptedData.length)
    const encryptedFile = new File([encryptedData as BufferSource], `${file.name}.v${newVersionNumber}.encrypted`, {
      type: 'application/octet-stream',
    })
    const uploadResult = await API.uploadFile(encryptedFile, authHeader)
    const uploadedSha256 = uploadResult['sha256'] as string

    // Build version metadata
    const versionMeta: FileVersion = {
      id: `${fileId}:v${newVersionNumber}`,
      fileId,
      version: newVersionNumber,
      sha256: uploadedSha256,
      plaintextHash,
      size: newFileData.byteLength,
      encryptedSize: encryptedData.length,
      timestamp: Math.floor(Date.now() / 1000),
      pubkey: authPort.pubkey!,
      note: versionNote,
      autoSave,
      previousVersion: currentVersions.length > 0 ? currentVersions[0].sha256 : null,
    }

    // Store version metadata locally
    await this.storeVersionMeta(versionMeta)

    // Publish updated file metadata with version tags
    // Events.createEncryptedFileMetadataEvent adds ['v', ...] and ['current', ...]
    // tags when `version` is present — see events.ts EncryptedFileMetadataInput.
    const metadataEvent = await Events.createEncryptedFileMetadataEvent({
      fileId,
      sha256: uploadedSha256,
      plaintextHash,
      name: file.name,
      size: versionMeta.size,
      encryptedSize: versionMeta.encryptedSize,
      mimeType: file.mime_type || file.mimeType || 'application/octet-stream',
      folderId: folderId ?? undefined,
      version: newVersionNumber,
    })

    await authPort.publishEvent(metadataEvent)

    // Wipe key from memory
    Crypto.wipeKey(fileKey)

    console.log(`Versioning: Created version ${newVersionNumber} for file ${fileId.slice(0, 8)}...`)

    return versionMeta
  },

  // Store version metadata in IndexedDB
  async storeVersionMeta(versionMeta: FileVersion): Promise<void> {
    if (!this.db) await this.openDB()

    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite')
      const store = tx.objectStore(this.STORE_NAME)
      const request = store.put(versionMeta)
      request.onsuccess = () => {
        // Update cache
        const cacheKey = versionMeta.fileId
        if (!this.versionCache.has(cacheKey)) {
          this.versionCache.set(cacheKey, [])
        }
        this.versionCache.get(cacheKey)!.unshift(versionMeta)
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  },

  // Get version history for a file (newest first)
  async getVersionHistory(fileId: string): Promise<FileVersion[]> {
    // Check cache first
    if (this.versionCache.has(fileId)) {
      return this.versionCache.get(fileId)!
    }

    if (!this.db) await this.openDB()

    return new Promise<FileVersion[]>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly')
      const store = tx.objectStore(this.STORE_NAME)
      const index = store.index('fileId')
      const request = index.getAll(IDBKeyRange.only(fileId))

      request.onsuccess = () => {
        const versions = (request.result || []) as FileVersion[]
        // Sort by version number (newest first)
        versions.sort((a, b) => b.version - a.version)
        // Cache the result
        this.versionCache.set(fileId, versions)
        resolve(versions)
      }

      request.onerror = () => reject(request.error)
    })
  },

  // Get a specific version
  async getVersion(fileId: string, versionNumber: number): Promise<FileVersion | undefined> {
    const versions = await this.getVersionHistory(fileId)
    return versions.find((v) => v.version === versionNumber)
  },

  // Download and decrypt a specific version
  async downloadVersion(file: VersionableFile, versionNumber: number): Promise<Uint8Array> {
    const fileId = extractFileId(file)
    const folderId = extractFolderId(file)

    const versionMeta = await this.getVersion(fileId, versionNumber)
    if (!versionMeta) {
      throw new Error(`Version ${versionNumber} not found`)
    }

    // Fetch the encrypted version
    const downloadUrl = API.getDownloadURL(versionMeta.sha256)
    const response = await fetch(downloadUrl)

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`)
    }

    const encryptedData = await response.arrayBuffer()

    // Decrypt with the file key (same key for all versions)
    let fileKey: Uint8Array
    if (folderId) {
      fileKey = await Keys.deriveFileKey(folderId, fileId)
    } else {
      fileKey = await Keys.deriveRootFileKey(fileId)
    }

    const decryptedData = await Crypto.decryptFile(encryptedData, fileKey)

    // Wipe key
    Crypto.wipeKey(fileKey)

    return decryptedData
  },

  // Restore a previous version (creates a new version from old data)
  async restoreVersion(file: VersionableFile, versionNumber: number): Promise<FileVersion> {
    // Download the old version
    const oldVersionData = await this.downloadVersion(file, versionNumber)

    // Create a new version with the old data
    const newVersion = await this.createVersion(file, oldVersionData, {
      versionNote: `Restored from version ${versionNumber}`,
      autoSave: false,
    })

    console.log(`Versioning: Restored version ${versionNumber} as version ${newVersion.version}`)

    return newVersion
  },

  // Compare two versions (returns metadata diff, not content diff)
  async compareVersions(
    fileId: string,
    versionA: number,
    versionB: number,
  ): Promise<VersionComparisonResult> {
    const versions = await this.getVersionHistory(fileId)
    const a = versions.find((v) => v.version === versionA)
    const b = versions.find((v) => v.version === versionB)

    if (!a || !b) {
      throw new Error('Version not found')
    }

    return {
      versionA: a,
      versionB: b,
      sizeDiff: b.size - a.size,
      timeDiff: b.timestamp - a.timestamp,
      sameContent: a.plaintextHash === b.plaintextHash,
    }
  },

  // Delete old versions, keeping the N most recent
  async pruneVersions(fileId: string, keepCount = 10): Promise<number> {
    const versions = await this.getVersionHistory(fileId)

    if (versions.length <= keepCount) {
      return 0
    }

    const toDelete = versions.slice(keepCount)
    let deleted = 0

    for (const version of toDelete) {
      try {
        // Delete from storage (optional — Blossom may auto-expire)
        // For now, just delete metadata
        await this.deleteVersionMeta(version.id)
        deleted++
      } catch (err) {
        console.warn(`Versioning: Failed to delete version ${version.version}:`, err)
      }
    }

    // Update cache
    this.versionCache.set(fileId, versions.slice(0, keepCount))

    console.log(`Versioning: Pruned ${deleted} old versions for file ${fileId.slice(0, 8)}...`)

    return deleted
  },

  // Delete version metadata from IndexedDB
  async deleteVersionMeta(versionId: string): Promise<void> {
    if (!this.db) await this.openDB()

    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite')
      const store = tx.objectStore(this.STORE_NAME)
      const request = store.delete(versionId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  },

  // Clear version cache
  clearCache(): void {
    this.versionCache.clear()
  },

  // Format version timestamp for display
  formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    return date.toLocaleString()
  },

  // Format time ago for display
  formatTimeAgo(timestamp: number): string {
    const now = Math.floor(Date.now() / 1000)
    const diff = now - timestamp

    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`
    if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`
    return this.formatTimestamp(timestamp)
  },

  // Auto-save version (for collaborative editing)
  async autoSaveVersion(
    file: VersionableFile,
    newFileData: Uint8Array | ArrayBuffer,
  ): Promise<FileVersion> {
    return this.createVersion(file, newFileData, {
      versionNote: 'Auto-save',
      autoSave: true,
    })
  },

  // Check if a file has version history
  async hasVersionHistory(fileId: string): Promise<boolean> {
    const versions = await this.getVersionHistory(fileId)
    return versions.length > 1
  },

  // Get the current (latest) version
  async getCurrentVersion(fileId: string): Promise<FileVersion | null> {
    const versions = await this.getVersionHistory(fileId)
    return versions.length > 0 ? versions[0] : null
  },

  // Get version diff for text files (basic line diff)
  async getTextDiff(
    file: VersionableFile,
    versionA: number,
    versionB: number,
  ): Promise<DiffLine[]> {
    const dataA = await this.downloadVersion(file, versionA)
    const dataB = await this.downloadVersion(file, versionB)

    const decoder = new TextDecoder()
    const textA = decoder.decode(dataA)
    const textB = decoder.decode(dataB)

    const linesA = textA.split('\n')
    const linesB = textB.split('\n')

    // Simple line-based diff
    const diff: DiffLine[] = []
    const maxLines = Math.max(linesA.length, linesB.length)

    for (let i = 0; i < maxLines; i++) {
      const lineA = linesA[i]
      const lineB = linesB[i]

      if (lineA === lineB) {
        diff.push({ type: 'unchanged', line: lineA, lineNum: i + 1 })
      } else if (lineA === undefined) {
        diff.push({ type: 'added', line: lineB, lineNum: i + 1 })
      } else if (lineB === undefined) {
        diff.push({ type: 'removed', line: lineA, lineNum: i + 1 })
      } else {
        diff.push({ type: 'removed', line: lineA, lineNum: i + 1 })
        diff.push({ type: 'added', line: lineB, lineNum: i + 1 })
      }
    }

    return diff
  },
}

export type VersioningModule = typeof Versioning
export default Versioning
