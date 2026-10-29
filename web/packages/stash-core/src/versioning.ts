// Verbatim port from legacy/js/versioning.js
// File version tracking, history, and restore for Cloistr Stash.
//
// BACKWARD-COMPATIBILITY CRITICAL: IndexedDB database name
// 'cloistr-drive-versions' and object store 'versions' are preserved
// byte-identical. Do NOT rename these — they reference existing user data.

import { Crypto } from './crypto'
import { Keys, type AccountFence } from './keys'
import { API } from './api'
import { editOwnEvent, loadOwnEvent, setTag } from './editEvent'
import { authPort } from './authBridge'
import { fileKeyFor, type FileRef } from './fileKey'
import { updateFile, withNewVersion } from './driveWrite'
import { fileRef, writeContext } from './sealedDrive'
import type { StashFile } from './types'

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
  /** The account the save is for (Keys.accountFence); taken now when omitted. */
  fence?: AccountFence
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

/**
 * The versions a file event already records, oldest first: its 'v' entries,
 * or, when it has none, its current blob as version 1 "Original".
 */
function versionsFromEvent(
  fileId: string,
  event: { created_at: number; tags: string[][]; content: string; pubkey?: string },
): FileVersion[] {
  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1]
  let content: Record<string, unknown> = {}
  try {
    content = JSON.parse(event.content) as Record<string, unknown>
  } catch {
    // sizes stay unknown
  }
  const owner = event.pubkey ?? authPort.pubkey ?? ''
  const base = { fileId, plaintextHash: '', size: 0, encryptedSize: 0, note: '', autoSave: false, pubkey: owner }

  const listed = event.tags
    .filter((t) => t[0] === 'v' && t[1] && Number(t[2]) > 0)
    .map((t) => ({ ...base, sha256: t[1], version: Number(t[2]), timestamp: Number(t[3]) || 0, pubkey: t[4] || owner }))
    .sort((a, b) => a.version - b.version)
  if (listed.length > 0) {
    return listed.map((v, i) => ({ ...v, id: `${fileId}:v${v.version}`, previousVersion: i > 0 ? listed[i - 1].sha256 : null }))
  }

  const sha256 = tag('x')
  if (!sha256) return []
  return [{
    ...base,
    id: `${fileId}:v1`,
    version: 1,
    sha256,
    plaintextHash: tag('ox') ?? '',
    size: Number(tag('size') ?? content.size) || 0,
    encryptedSize: Number(content.encrypted_size) || 0,
    timestamp: event.created_at,
    note: 'Original',
    previousVersion: null,
  }]
}

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
    // Every signature, upload and publish below refuses once the account
    // changes, so a save that outlives an account switch writes nothing.
    const fence = options.fence ?? Keys.accountFence() ?? undefined

    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    const fileId = extractFileId(file)
    const folderId = extractFolderId(file)

    // Refuse before uploading anything if the file's current event cannot be
    // loaded: the new version is merged into it (see below). A sealed file is
    // checked by updateFile itself, against its ring reference.
    const sealed = (file as Record<string, unknown>).sealed === true
    const ref = sealed ? fileRef(file as StashFile) : null
    const currentEvent = sealed ? null : await loadOwnEvent(30078, fileId)
    Keys.assertAccount(fence)

    // History lives on this device. On a device with none yet, seed it from
    // the file event first, so the content before this save stays listed and
    // restorable (STASH-25: the original used to vanish from Versions). Only
    // an old-shape event has readable version tags to seed from.
    let currentVersions = await this.getVersionHistory(fileId)
    const seeded = currentVersions.length === 0 && currentEvent ? versionsFromEvent(fileId, currentEvent) : []
    for (const v of seeded) await this.storeVersionMeta(v)
    if (seeded.length > 0) currentVersions = await this.getVersionHistory(fileId)
    const newVersionNumber = currentVersions.reduce((n, v) => Math.max(n, Number(v.version) || 0), currentVersions.length) + 1

    // The file's own key: its wrapped key, or HKDF for a legacy file.
    const fileKey = await fileKeyFor(file as FileRef, fence)

    try {
      const encryptedData = await Crypto.encryptFile(newFileData, fileKey)
      const encryptedHash = await Crypto.hash(encryptedData)
      const plaintextHash = await Crypto.hash(
        newFileData instanceof Uint8Array ? newFileData : new Uint8Array(newFileData),
      )

      // Upload the new version blob
      Keys.assertAccount(fence)
      const authHeader = await authPort.createUploadAuth(encryptedHash, encryptedData.length)
      Keys.assertAccount(fence)
      const encryptedFile = new Blob([encryptedData as BufferSource], { type: 'application/octet-stream' })
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
      Keys.assertAccount(fence)
      await this.storeVersionMeta(versionMeta)

      // Merge the new version into the file's CURRENT event: owner_key (the
      // same key encrypted this version), earlier 'v' entries, tags and any
      // other field are kept; only the blob-specific fields change.
      // (Rebuilding it from `file` dropped owner_key: found 2026-10-09.)
      if (ref) {
        const ctx = await writeContext()
        Keys.assertAccount(fence)
        await updateFile(ctx, ref, (m) =>
          withNewVersion(
            m,
            { sha256: uploadedSha256, size: versionMeta.size, encryptedSize: versionMeta.encryptedSize, plaintextHash },
            versionMeta.timestamp,
          ),
        )
      } else await editOwnEvent(30078, fileId, (draft) => {
        setTag(draft, 'x', uploadedSha256)
        setTag(draft, 'ox', plaintextHash)
        setTag(draft, 'size', String(versionMeta.size))
        draft.content.size = versionMeta.size
        draft.content.encrypted_size = versionMeta.encryptedSize
        for (const v of seeded) {
          if (!draft.tags.some((t) => t[0] === 'v' && t[1] === v.sha256)) {
            draft.tags.push(['v', v.sha256, String(v.version), String(v.timestamp), v.pubkey])
          }
        }
        draft.tags.push(['v', uploadedSha256, String(newVersionNumber), String(versionMeta.timestamp), authPort.pubkey!])
        setTag(draft, 'current', uploadedSha256)
      }, fence)

      console.log(`Versioning: Created version ${newVersionNumber} for file ${fileId.slice(0, 8)}...`)

      return versionMeta
    } finally {
      // Wipe key from memory, on failure too: for a wrapped file this is the
      // file's only key, not one re-derivable from the root.
      Crypto.wipeKey(fileKey)
    }
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
  async downloadVersion(file: VersionableFile, versionNumber: number, fence?: AccountFence): Promise<Uint8Array> {
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

    // Decrypt with the file key (same key for all versions). A wrapped-key file
    // may also hold versions saved before 2026-10-07 under the derived key;
    // a wrong key fails authentication cleanly (XChaCha20-Poly1305 yields no
    // plaintext on failure), so try that one second.
    const fileKey = await fileKeyFor(file as FileRef, fence)
    try {
      try {
        return await Crypto.decryptFile(encryptedData, fileKey)
      } catch (err) {
        if (!(file as FileRef).owner_key) throw err
        const legacyKey = folderId
          ? await Keys.deriveFileKey(folderId, fileId, fence)
          : await Keys.deriveRootFileKey(fileId)
        try {
          return await Crypto.decryptFile(encryptedData, legacyKey)
        } finally {
          Crypto.wipeKey(legacyKey)
        }
      }
    } finally {
      // Every exit, including both attempts failing
      Crypto.wipeKey(fileKey)
    }
  },

  // Restore a previous version (creates a new version from old data)
  async restoreVersion(file: VersionableFile, versionNumber: number): Promise<FileVersion> {
    // One account for both halves: the download can outlive a switch.
    const fence = Keys.accountFence() ?? undefined
    // Download the old version
    const oldVersionData = await this.downloadVersion(file, versionNumber, fence)

    // Create a new version with the old data
    const newVersion = await this.createVersion(file, oldVersionData, {
      versionNote: `Restored from version ${versionNumber}`,
      autoSave: false,
      fence,
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
    fence?: AccountFence,
  ): Promise<FileVersion> {
    return this.createVersion(file, newFileData, {
      versionNote: 'Auto-save',
      autoSave: true,
      fence,
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
