// Verbatim port of legacy/js/sharing.js to typed TypeScript ESM.
// Nostr event kinds used:
//   30080 — file/folder share (encrypted content, recipient addressed via NIP-04/44)
//   30081 — public share tracking (unencrypted content, SHA-256 indexed)
//
// Changes from legacy (all forced by the no-globals, no-DOM rule):
//   - Auth global   → authPort  (from ./authBridge)
//   - Keys/Crypto/API globals → imported singletons
//   - window.location.origin  → baseUrl parameter on generatePublicLink /
//                               createExpiringLink (callers supply it)
//   - Auth.generateShareId()          → local helper (crypto.getRandomValues)
//   - Auth.createEncryptedFileMetadataEvent() → local helper (kind 30078)
//   - Auth.createDeleteAuth()         → local helper (Blossom kind 24242 t=delete)
//   - UI.toast()                      → dropped (pure UI; callers handle feedback)

import { Crypto } from './crypto'
import { Keys, AccountChangedError, type AccountFence } from './keys'
import { API } from './api'
import { Relay } from './relay'
import { authPort, getSigner } from './authBridge'
import { addWrappedKeyToFolder } from './upload'
import { Events } from './events'
import * as Sealed from './driveWrite'
import { writeContext, writesSealed } from './sealedDrive'
import { SEALED_FILE_KIND } from './sealed'
import { listSharedFolder, type DriveSnapshot } from './drive'
import type { UnsignedEvent, SignedEvent } from './relay'
import type { StashFile, StashFolder } from './types'

/** A file in a shared folder that the shared folder's key does not open. */
export class SharedKeyCannotOpenError extends Error {
  constructor(name: string) {
    super(`"${name}" can't be opened with the shared folder's key. Ask the owner to share the file itself.`)
    this.name = 'SharedKeyCannotOpenError'
  }
}

// ─── Public input/output interfaces ──────────────────────────────────────────

export interface ShareFileOptions {
  permission?: string
  expiresAt?: number | null
  message?: string
}

export interface ShareFolderOptions {
  permission?: string
  expiresAt?: number | null
  message?: string
}

export interface ShareResult {
  shareId: string
  recipientPubkey: string
  permission: string
  expiresAt: number | null
}

export interface PublicLinkOptions {
  expiresAt?: number | null
  maxDownloads?: number | null
}

export interface PublicLinkResult {
  url: string
  key: string
  sha256: string
  expiresAt: number | null
}

export interface ParsedPublicLink {
  sha256: string
  key: string
  keyBytes: Uint8Array | null
}

export interface AcceptedShareResult {
  type: string
  fileId?: string
  fileName?: string
  sha256?: string
  folderId?: string
  folderName?: string
}

export interface ReencryptResult {
  oldFileId: string
  newFileId: string
  oldHash: string
  newHash: string
}

/** How far a revoke-and-re-encrypt got before it stopped. */
export type RevokeStage = 'not-started' | 'old-copy-remains' | 'share-notices' | 'old-record'

/** A revoke that stopped partway, kept until Sharing.retryRevoke finishes it. */
export interface PendingRevoke {
  stage: RevokeStage
  /** The account that started it: only that account may finish it. */
  pubkey: string
  fileId: string
  oldSha256: string
  newFileId?: string
  newHash?: string
  /** The old file's sealed record (its d and container), when it was sealed. */
  oldSealed?: { d: string; folderId: string | null }
  /**
   * The new copy's signed record when its publish threw: it may have landed
   * with the answer lost. A retry asks the relay for it before publishing it
   * again, and removes nothing until it is there.
   */
  newEvent?: SignedEvent
}

/**
 * A revoke-and-re-encrypt that stopped partway (an account switch, or a failure
 * after the new copy was published). `pending.stage` says what is still true:
 *  - 'not-started': nothing visible changed; the old shares still work.
 *  - 'old-copy-remains': the new copy is published but the old blob is still
 *    stored, so the people the file was shared with can still open it.
 *  - 'share-notices': the old blob is gone, but the share records were not withdrawn.
 *  - 'old-record': all of that is done, but the old file's record is still
 *    listed beside the new copy, naming a blob that no longer exists.
 * Never report a revoke that threw this as done.
 */
export class RevokeIncompleteError extends Error {
  constructor(
    readonly pending: PendingRevoke,
    readonly reason: unknown,
  ) {
    super(`Re-encryption did not finish: ${reason instanceof Error ? reason.message : String(reason)}`)
    this.name = 'RevokeIncompleteError'
  }
}

// Unfinished revokes by file id. Kept in localStorage so a reload or an account
// switch does not forget one; memory only where localStorage is unavailable.
// Ids, blob hashes and at most the new copy's signed record (whose only key
// is the owner's wrapped envelope), never a raw key.
const PENDING_REVOKES_KEY = 'cloistr-stash-pending-revokes'
let pendingRevokes: Record<string, PendingRevoke> | null = null

function pendingRevokeStore(): Record<string, PendingRevoke> {
  if (!pendingRevokes) {
    try {
      pendingRevokes = JSON.parse(globalThis.localStorage?.getItem(PENDING_REVOKES_KEY) ?? '{}') ?? {}
    } catch {
      pendingRevokes = {}
    }
  }
  return pendingRevokes!
}

function savePendingRevokes(): void {
  try {
    globalThis.localStorage?.setItem(PENDING_REVOKES_KEY, JSON.stringify(pendingRevokeStore()))
  } catch {
    // memory only
  }
}

/** Shape of an incoming share record returned by the API. */
export interface IncomingShare {
  owner_pubkey: string
  encrypted_content: string
  id: string
  [key: string]: unknown
}

/** Incoming share with its content decrypted (or error recorded). */
export interface DecryptedIncomingShare extends IncomingShare {
  content?: unknown
  decrypted: boolean
  error?: string
  /** This device holds the key that accepting the share stores. */
  accepted?: boolean
}

export interface SharedFileDownload {
  data: Uint8Array
  name: string
  mimeType: string
}

// ─── Internal content shapes (used when building/parsing events) ──────────────

interface ShareFileContent {
  type: 'file'
  fileId: string
  fileName: string
  fileSize: number | undefined
  fileMimeType: string | undefined
  fileSHA256: string
  fileURL: string
  fileKey: string
  message: string
  encrypted: boolean
}

interface ShareFolderContent {
  type: 'folder'
  folderId: string
  folderName: string
  folderKey: string
  message: string
}

interface SharePublicContent {
  type: 'public'
  fileId: string
  fileName: string
  fileSHA256: string
  expiresAt: number | null
  maxDownloads: number | null
}

type ShareContent = ShareFileContent | ShareFolderContent | SharePublicContent

interface ShareEventInfo {
  id: string
  recipientPubkey: string
  shareContent: ShareContent
  permission: string
  expiresAt: number | null
}

interface EncryptedFileMetadataParams {
  fileId: string
  sha256: string
  plaintextHash: string
  name: string
  size: number
  encryptedSize: number
  mimeType: string
  folderId: string | null
  encrypted: boolean
  ownerEnvelope?: string
}

// ─── Module-private helpers ───────────────────────────────────────────────────

function generateShareId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Crypto.bytesToHex(bytes)
}

// ─── Local share index (IndexedDB) ──────────────────────────────────────────
// Written at publish time so the sharer can list their own outgoing shares
// without a decrypt sweep of every share they ever made. The relay stays the
// portable source of truth; this is a local cache.

interface ShareIndexEntry {
  id: string
  fileId: string
  recipientPubkey: string
  permission: string
  expiresAt: number | null
  createdAt: number
}

const SHARE_DB_NAME = 'cloistr-drive-shares'
const SHARE_STORE = 'outgoing'

function openShareDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(SHARE_DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(SHARE_STORE)) {
          const store = db.createObjectStore(SHARE_STORE, { keyPath: 'id' })
          store.createIndex('fileId', 'fileId', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    } catch (e) {
      reject(e)
    }
  })
}

async function writeShareIndex(entry: ShareIndexEntry): Promise<void> {
  try {
    const db = await openShareDB()
    const tx = db.transaction(SHARE_STORE, 'readwrite')
    tx.objectStore(SHARE_STORE).put(entry)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // Non-fatal: the relay is the source of truth
  }
}

async function queryShareIndex(fileId: string): Promise<ShareIndexEntry[]> {
  const db = await openShareDB()
  const tx = db.transaction(SHARE_STORE, 'readonly')
  const idx = tx.objectStore(SHARE_STORE).index('fileId')
  const req = idx.getAll(fileId)
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as ShareIndexEntry[])
    req.onerror = () => reject(req.error)
  })
}

async function createEncryptedFileMetadataEvent(
  params: EncryptedFileMetadataParams,
): Promise<SignedEvent> {
  const tags: string[][] = [
    ['d', params.fileId],
    ['x', params.sha256],
    ['ox', params.plaintextHash],
    ['size', params.encryptedSize.toString()],
    ['m', params.mimeType],
    ['name', params.name],
  ]

  if (params.folderId) {
    tags.push(['folder', params.folderId])
  }
  if (params.encrypted) {
    tags.push(['encrypted', 'true'])
  }
  if (params.ownerEnvelope) {
    tags.push(['owner_key', params.ownerEnvelope])
  }

  const event: UnsignedEvent = {
    kind: 30078, // encrypted file metadata
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      name: params.name,
      size: params.size,
      mimeType: params.mimeType,
      sha256: params.sha256,
      encrypted: params.encrypted,
      folderId: params.folderId,
    }),
  }

  return authPort.signEvent(event)
}

async function createDeleteAuth(sha256: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000)
  const signed = await authPort.signEvent({
    kind: 24242,
    created_at: ts,
    tags: [
      ['t', 'delete'],
      ['x', sha256],
      ['expiration', (ts + 300).toString()],
    ],
    content: `Delete ${sha256}`,
  })
  return `Nostr ${btoa(JSON.stringify(signed))}`
}

// ─── Sharing singleton ────────────────────────────────────────────────────────

export const Sharing = {
  // Share types
  SHARE_TYPE_FILE: 'file' as const,
  SHARE_TYPE_FOLDER: 'folder' as const,
  SHARE_TYPE_PUBLIC: 'public' as const,

  // Permission levels
  PERMISSION_VIEW: 'view' as const,
  PERMISSION_DOWNLOAD: 'download' as const,
  PERMISSION_EDIT: 'edit' as const,

  // Active shares cache
  sharesCache: new Map<string, unknown>(),

  // Initialize sharing module
  async init(): Promise<void> {
    console.log('Sharing: Initialized')
  },

  // Peer-directed encryption for share keys/content. Delegates to the single
  // scheme policy in Keys (prefer NIP-44 when the nip44Writes gate is on and the
  // signer supports it; else NIP-04). Decrypt accepts either scheme, so legacy
  // NIP-04 shares stay readable. See docs/migration-nip04-to-nip44-root-key.md.
  async encryptForRecipient(recipientPubkey: string, plaintext: string): Promise<string> {
    return Keys.selfEncrypt(recipientPubkey, plaintext)
  },
  async decryptFromSender(senderPubkey: string, ciphertext: string): Promise<string> {
    return Keys.selfDecrypt(senderPubkey, ciphertext)
  },

  // Share a file with a specific recipient.
  // Encrypts the file key with recipient's pubkey via NIP-44.
  async shareFile(
    file: StashFile,
    recipientPubkey: string,
    options: ShareFileOptions = {},
  ): Promise<ShareResult> {
    const { permission = this.PERMISSION_DOWNLOAD, expiresAt = null, message = '' } = options

    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    // Get the file key
    const fileId = (file.file_id ?? file.fileId ?? file.id ?? file.d) as string | undefined
    const folderId = (file.folder_id ?? file.folderId ?? file.folder ?? null) as string | null

    if (!fileId) {
      throw new Error('Cannot share: missing file ID')
    }

    // The account this action is for: the key fetch and any publish below
    // refuse once it changes (an account switch mid-action).
    const fence = Keys.accountFence() ?? undefined
    const fileKey = await Keys.getFileKey(folderId, fileId, {
      ownerEnvelope: file.owner_key,
      signer: getSigner(),
      fence,
    })

    // Encrypt the file key for the recipient (NIP-44 preferred, NIP-04 fallback),
    // then wipe it, on failure too: for a wrapped file it is the only key.
    let encryptedFileKey: string
    try {
      Keys.assertAccount(fence)
      encryptedFileKey = await this.encryptForRecipient(recipientPubkey, Crypto.bytesToHex(fileKey))
    } finally {
      Crypto.wipeKey(fileKey)
    }

    // Create share content
    const shareContent: ShareFileContent = {
      type: this.SHARE_TYPE_FILE,
      fileId: fileId,
      fileName: file.name,
      fileSize: file.size,
      fileMimeType: (file.mime_type ?? file.mimeType) as string | undefined,
      fileSHA256: file.sha256,
      fileURL: API.getDownloadURL(file.sha256),
      fileKey: encryptedFileKey,
      message: message,
      encrypted: (file.encrypted ?? false) as boolean,
    }

    // Generate share ID
    const shareId = generateShareId()

    // Create the share event
    const signedEvent = await this.createShareEvent({
      id: shareId,
      recipientPubkey: recipientPubkey,
      shareContent: shareContent,
      permission: permission,
      expiresAt: expiresAt ?? null,
    })

    // Publish to relay
    Keys.assertAccount(fence)
    await authPort.publishEvent(signedEvent)

    // Write to local share index so the sharer can list their own outgoing
    // shares without a decrypt sweep of every share they ever made.
    void writeShareIndex({
      id: shareId,
      fileId: fileId,
      recipientPubkey,
      permission,
      expiresAt: expiresAt ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    })

    console.log('Sharing: File shared with', recipientPubkey.slice(0, 8) + '...')

    return {
      shareId: shareId,
      recipientPubkey: recipientPubkey,
      permission: permission,
      expiresAt: expiresAt ?? null,
    }
  },

  // Share a folder with a specific recipient.
  // Encrypts the folder key with recipient's pubkey via NIP-44.
  async shareFolder(
    folder: StashFolder,
    recipientPubkey: string,
    options: ShareFolderOptions = {},
  ): Promise<ShareResult> {
    const { permission = this.PERMISSION_DOWNLOAD, expiresAt = null, message = '' } = options

    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    const folderId = folder.id

    if (!folderId) {
      throw new Error('Cannot share: missing folder ID')
    }

    // Own folders carry their self-encrypted key tag, which is authoritative;
    // never hand a recipient a key that disagrees with it.
    const fence = Keys.accountFence() ?? undefined
    const folderKey = folder.encrypted_key
      ? await Keys.resolveOwnFolderKey(folderId, folder.encrypted_key, folder.parent_id ?? null, fence)
      : await Keys.getFolderKey(folderId, folder.parent_id ?? null, fence)

    // Encrypt the folder key for the recipient (NIP-44 preferred, NIP-04 fallback)
    Keys.assertAccount(fence)
    const folderKeyHex = Crypto.bytesToHex(folderKey)
    const encryptedFolderKey = await this.encryptForRecipient(recipientPubkey, folderKeyHex)

    // Create share content
    const shareContent: ShareFolderContent = {
      type: this.SHARE_TYPE_FOLDER,
      folderId: folderId,
      folderName: folder.name,
      folderKey: encryptedFolderKey,
      message: message,
    }

    // Generate share ID
    const shareId = generateShareId()

    // Create the share event
    const signedEvent = await this.createShareEvent({
      id: shareId,
      recipientPubkey: recipientPubkey,
      shareContent: shareContent,
      permission: permission,
      expiresAt: expiresAt ?? null,
    })

    // Publish to relay
    Keys.assertAccount(fence)
    await authPort.publishEvent(signedEvent)

    void writeShareIndex({
      id: shareId,
      fileId: folderId,
      recipientPubkey,
      permission,
      expiresAt: expiresAt ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    })

    console.log('Sharing: Folder shared with', recipientPubkey.slice(0, 8) + '...')

    return {
      shareId: shareId,
      recipientPubkey: recipientPubkey,
      permission: permission,
      expiresAt: expiresAt ?? null,
    }
  },

  // Create a Nostr kind-30080 share event (file/folder share).
  async createShareEvent(shareInfo: ShareEventInfo): Promise<SignedEvent> {
    const now = Math.floor(Date.now() / 1000)

    // Encrypt the share content + permission for the recipient (NIP-44 preferred).
    // Item coordinate and permission are ONLY in the encrypted payload — plaintext
    // tags carry nothing beyond the recipient, so a stranger learns only that two
    // keys exchanged something.
    const contentJson = JSON.stringify({
      ...shareInfo.shareContent,
      permission: shareInfo.permission,
      expiresAt: shareInfo.expiresAt,
    })
    const encryptedContent = await this.encryptForRecipient(shareInfo.recipientPubkey, contentJson)

    const event: UnsignedEvent = {
      kind: 30080, // Share kind
      created_at: now,
      tags: [
        ['d', shareInfo.id],
        ['p', shareInfo.recipientPubkey],
      ],
      content: encryptedContent,
    }

    // Expiration stays as a plaintext tag because our relay implements NIP-40
    // (rejects expired events, filters them from queries). This provides
    // self-cleaning share records at the cost of leaking when a share ends.
    // The value is also inside the encrypted payload for the recipient.
    if (shareInfo.expiresAt) {
      event.tags.push(['expiration', shareInfo.expiresAt.toString()])
    }

    return authPort.signEvent(event)
  },

  // Generate a public link for a file.
  // The decryption key is embedded in the URL fragment (never sent to server).
  // baseUrl: caller supplies window.location.origin — this module has no DOM access.
  // Optionally publishes a kind-30081 tracking event when expiresAt or maxDownloads is set.
  async generatePublicLink(
    file: StashFile,
    baseUrl: string,
    options: PublicLinkOptions = {},
  ): Promise<PublicLinkResult> {
    const { expiresAt = null, maxDownloads = null } = options

    const fileId = (file.file_id ?? file.fileId ?? file.id ?? file.d) as string | undefined
    const folderId = (file.folder_id ?? file.folderId ?? file.folder ?? null) as string | null

    if (!fileId) {
      throw new Error('Cannot generate link: missing file ID')
    }

    // The account this action is for: the key fetch and any publish below
    // refuse once it changes (an account switch mid-action).
    const fence = Keys.accountFence() ?? undefined
    const fileKey = await Keys.getFileKey(folderId, fileId, {
      ownerEnvelope: file.owner_key,
      signer: getSigner(),
      fence,
    })

    // Encode the key for URL fragment; the bytes are not needed after that.
    let keyBase64url: string
    try {
      Keys.assertAccount(fence)
      keyBase64url = Crypto.bytesToBase64url(fileKey)
    } finally {
      Crypto.wipeKey(fileKey)
    }

    // Build the public link URL
    // Format: {origin}/public/{sha256}#{key}
    const publicUrl = `${baseUrl}/public/${file.sha256}#${keyBase64url}`

    // Optionally create a share record for tracking/expiration
    if (expiresAt || maxDownloads) {
      const shareId = generateShareId()

      const shareContent: SharePublicContent = {
        type: this.SHARE_TYPE_PUBLIC,
        fileId: fileId,
        fileName: file.name,
        fileSHA256: file.sha256,
        expiresAt: expiresAt ?? null,
        maxDownloads: maxDownloads ?? null,
      }

      // Create a public share event (no recipient, no encrypted key)
      const tags: string[][] = [
        ['d', shareId],
        ['file', `30078:${authPort.pubkey}:${fileId}`],
        ['x', file.sha256],
      ]

      if (expiresAt) {
        tags.push(['expiration', expiresAt.toString()])
      }

      if (maxDownloads) {
        tags.push(['max_downloads', maxDownloads.toString()])
      }

      const event: UnsignedEvent = {
        kind: 30081, // Public share kind
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify(shareContent),
      }

      Keys.assertAccount(fence)
      const signedEvent = await authPort.signEvent(event)
      Keys.assertAccount(fence)
      await authPort.publishEvent(signedEvent)
    }

    console.log('Sharing: Generated public link for', file.name)

    return {
      url: publicUrl,
      key: keyBase64url,
      sha256: file.sha256,
      expiresAt: expiresAt ?? null,
    }
  },

  // Parse a public link and extract components.
  parsePublicLink(url: string): ParsedPublicLink {
    const parsed = new URL(url)
    const pathParts = parsed.pathname.split('/')
    const sha256 = pathParts[pathParts.length - 1]
    const key = parsed.hash.slice(1) // Remove the #

    return {
      sha256: sha256,
      key: key,
      keyBytes: key ? Crypto.base64urlToBytes(key) : null,
    }
  },

  // Download and decrypt from a public link.
  async downloadFromPublicLink(url: string): Promise<Uint8Array> {
    const { sha256, keyBytes } = this.parsePublicLink(url)

    if (!sha256 || !keyBytes) {
      throw new Error('Invalid public link')
    }

    // Fetch the encrypted file
    const downloadUrl = API.getDownloadURL(sha256)
    const response = await fetch(downloadUrl)

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`)
    }

    const encryptedData = await response.arrayBuffer()

    // Decrypt using the key from URL fragment
    const decryptedData = await Crypto.decryptFile(encryptedData, keyBytes)

    return decryptedData
  },

  // Revoke all shares for a file and re-encrypt with a new key.
  // Downloads, decrypts, generates new fileId/key, re-encrypts, uploads, updates metadata.
  async revokeAndReencryptFile(file: StashFile): Promise<ReencryptResult> {
    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    const fileId = (file.file_id ?? file.fileId ?? file.id ?? file.d) as string | undefined
    const folderId = (file.folder_id ?? file.folderId ?? file.folder ?? null) as string | null

    if (!fileId) {
      throw new Error('Cannot revoke: missing file ID')
    }
    // The account this revoke is for: every key fetch, signature, upload,
    // publish and delete below refuses once it changes.
    const fence = Keys.accountFence() ?? undefined
    // A sealed record is reached by its d, never by the file id.
    const oldSealed = file.sealed === true && file.d ? { d: file.d as string, folderId } : undefined
    // How far it got, so a stop is reported as unfinished and can be resumed.
    let stage: RevokeStage = 'not-started'
    let newFileId: string | undefined
    let uploadedHash: string | undefined
    let unconfirmed: SignedEvent | undefined

    // UI.toast dropped (pure UI)

    // Step 1: Download the encrypted file
    const downloadUrl = API.getDownloadURL(file.sha256)
    const response = await fetch(downloadUrl)
    const encryptedData = await response.arrayBuffer()

    // Step 2: Decrypt with old key
    const oldFileKey = await Keys.getFileKey(folderId, fileId, {
      ownerEnvelope: file.owner_key,
      signer: getSigner(),
      fence,
    })

    // Step 3: Generate new file ID
    newFileId = Crypto.generateFileId()

    // Step 4: a new random key, wrapped to the owner and under the folder key.
    // Never derived (architecture/key-model.md): a revoke must not hand back a
    // key anyone holding the folder or root key can recompute. Both keys are
    // wiped on every exit, a failure included.
    const newFileKey = Keys.generateFileKey()
    try {
      // A sealed file, or any file in a sealed drive, gets its new copy sealed
      // as upload does: never an old-shape record with the name in the clear.
      const sealedWrite = file.sealed === true || (await writesSealed())
      const decryptedData = await Crypto.decryptFile(encryptedData, oldFileKey)
      Keys.assertAccount(fence)
      const ownerEnvelope = sealedWrite ? undefined : await Keys.wrapFileKeyForOwner(newFileKey, newFileId, getSigner())

      // Step 5: Re-encrypt with new key
      const reencryptedData = await Crypto.encryptFile(decryptedData, newFileKey)

      // Step 6: Calculate new hash
      const newHash = await Crypto.hash(reencryptedData)

      // Step 7: Upload new encrypted blob
      Keys.assertAccount(fence)
      const authHeader = await authPort.createUploadAuth(newHash, reencryptedData.length)
      Keys.assertAccount(fence)
      const encryptedBlob = new Blob([reencryptedData as BlobPart], {
        type: 'application/octet-stream',
      })
      const uploadResult = (await API.uploadFile(encryptedBlob, authHeader)) as { sha256: string }
      uploadedHash = uploadResult.sha256

      // The folder's wrapped copy only once the blob exists, as upload does: a
      // failed re-encrypt or upload must not leave a wk for a file that is not there.
      if (folderId && !sealedWrite) {
        await addWrappedKeyToFolder(folderId, newFileId, newFileKey, fence)
      }

      // Step 8: Publish new metadata event
      if (sealedWrite) {
        const ctx = await writeContext()
        Keys.assertAccount(fence)
        // The file's sealed record is kept as unconfirmed from signing until
        // the relay answers, as below. Its ring entry is not: the owner's
        // drive opens a file outside any ring through its owner envelope.
        stage = 'old-copy-remains'
        await Sealed.addFile(
          {
            ...ctx,
            publish: async (ev) => {
              Keys.assertAccount(fence)
              const signed = await authPort.signEvent(ev)
              Keys.assertAccount(fence)
              const fileRecord = signed.kind === SEALED_FILE_KIND
              if (fileRecord) unconfirmed = signed
              await authPort.publishEvent(signed)
              if (fileRecord) unconfirmed = undefined
              return signed
            },
          },
          {
            key: newFileKey,
            meta: {
              id: newFileId,
              name: file.name,
              folderId: folderId || null,
              sha256: uploadResult.sha256,
              plaintextHash: await Crypto.hash(decryptedData),
              size: decryptedData.length,
              encryptedSize: reencryptedData.length,
              mimeType: (file.mime_type ?? file.mimeType ?? 'application/octet-stream') as string,
            },
          },
        )
        return await this.completeRevoke(
          {
            stage,
            pubkey: fence?.pubkey ?? '',
            fileId,
            oldSha256: file.sha256,
            newFileId,
            newHash: uploadedHash,
            oldSealed,
          },
          fence,
        )
      }

      const metadataEvent = await createEncryptedFileMetadataEvent({
        fileId: newFileId,
        sha256: uploadResult.sha256,
        plaintextHash: await Crypto.hash(decryptedData),
        name: file.name,
        size: decryptedData.length,
        encryptedSize: reencryptedData.length,
        mimeType: (file.mime_type ?? file.mimeType ?? 'application/octet-stream') as string,
        folderId: folderId,
        encrypted: true,
        ownerEnvelope,
      })
      Keys.assertAccount(fence)
      // From here a failure may still have landed (the answer lost), so it is
      // kept with the signed record rather than thrown with no trace, which
      // made a second revoke publish a second copy.
      stage = 'old-copy-remains'
      unconfirmed = metadataEvent
      await authPort.publishEvent(metadataEvent)
      unconfirmed = undefined

      return await this.completeRevoke(
        {
          stage,
          pubkey: fence?.pubkey ?? '',
          fileId,
          oldSha256: file.sha256,
          newFileId,
          newHash: uploadedHash,
          oldSealed,
        },
        fence,
      )
    } catch (err) {
      if (err instanceof RevokeIncompleteError) throw err
      // Before the publish a failure changed nothing visible, and only an
      // account switch is worth offering a retry for; after it, any failure
      // leaves the old copy readable.
      if (stage === 'not-started' && !(err instanceof AccountChangedError)) throw err
      const pending: PendingRevoke = {
        stage,
        pubkey: fence?.pubkey ?? '',
        fileId,
        oldSha256: file.sha256,
        newFileId,
        newHash: uploadedHash,
        oldSealed,
        newEvent: unconfirmed,
      }
      pendingRevokeStore()[fileId] = pending
      savePendingRevokes()
      throw new RevokeIncompleteError(pending, err)
    } finally {
      Crypto.wipeKey(oldFileKey)
      Crypto.wipeKey(newFileKey)
    }
  },

  /**
   * The rest of a revoke once the new copy is published: remove the old blob
   * (the step that actually stops old shares opening the file), withdraw the
   * share records, then withdraw the old file's own record. Throws
   * RevokeIncompleteError, keeping the record, if any stops; clears it when
   * all are done.
   */
  async completeRevoke(p: PendingRevoke, fence?: AccountFence): Promise<ReencryptResult> {
    let stage = p.stage
    let newEvent = p.newEvent
    try {
      if (stage === 'old-copy-remains' && newEvent) {
        // Never remove the old copy before the new one's record is on the relay.
        const ev = newEvent
        const found = await Relay.query([{ ids: [ev.id] }])
        if (!found.some((e) => e.id === ev.id)) {
          Keys.assertAccount(fence)
          await authPort.publishEvent(ev)
        }
        newEvent = undefined
      }
      if (stage === 'old-copy-remains') {
        Keys.assertAccount(fence)
        const deleteAuth = await createDeleteAuth(p.oldSha256)
        Keys.assertAccount(fence)
        try {
          await API.deleteFile(p.oldSha256, deleteAuth)
        } catch (err) {
          // A retry after a delete whose answer was lost: already gone is done.
          if (!/\b404\b|not found/i.test((err as Error).message)) throw err
        }
        stage = 'share-notices'
      }

      // Request deletion of stale share events from the relay.
      // These are requests, not guarantees: other relays and local caches retain
      // copies. The real protection is that the old key no longer decrypts anything.
      // Note: a deletion request is itself a public event announcing that a share
      // was withdrawn. It does not name the recipient, but it signals that a
      // revocation happened. Prefer expiry over deletion where both are available.
      // Best-effort, except that an account switch leaves it unfinished.
      if (stage === 'share-notices') {
        try {
          const staleShares = await this.listOutgoingSharesForFile(p.fileId)
          for (const share of staleShares) {
            const deleteEvent: UnsignedEvent = {
              kind: 5,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['a', `30080:${authPort.pubkey}:${share.id}`]],
              content: '',
            }
            Keys.assertAccount(fence)
            const signed = await authPort.signEvent(deleteEvent)
            Keys.assertAccount(fence)
            await authPort.publishEvent(signed)
          }
        } catch (err) {
          if (err instanceof AccountChangedError) throw err
          // Otherwise best-effort: failure is expected and documented
        }
        stage = 'old-record'
      }

      // The old file's record: left behind, it lists a file whose blob is gone
      // beside its new copy. Not best-effort: a failure here is reported.
      if (stage === 'old-record') {
        Keys.assertAccount(fence)
        if (p.oldSealed) {
          await Sealed.deleteFile(await writeContext(), { d: p.oldSealed.d }, p.oldSealed.folderId)
        } else {
          const deletion = await Events.createBatchDeleteEvent([p.fileId], [])
          Keys.assertAccount(fence)
          await authPort.publishEvent(deletion)
        }
      }
    } catch (err) {
      const pending: PendingRevoke = { ...p, stage, newEvent }
      pendingRevokeStore()[p.fileId] = pending
      savePendingRevokes()
      throw new RevokeIncompleteError(pending, err)
    }

    this.clearPendingRevoke(p.fileId)
    console.log('Sharing: File re-encrypted with new key')
    return { oldFileId: p.fileId, newFileId: p.newFileId ?? '', oldHash: p.oldSha256, newHash: p.newHash ?? '' }
  },

  /** The unfinished revoke for this file, if one stopped partway. */
  pendingRevoke(fileId: string): PendingRevoke | null {
    return pendingRevokeStore()[fileId] ?? null
  },

  clearPendingRevoke(fileId: string): void {
    if (!(fileId in pendingRevokeStore())) return
    delete pendingRevokeStore()[fileId]
    savePendingRevokes()
  },

  /**
   * Finish a revoke that stopped partway, from where it stopped. Only the
   * account that started it may finish it: another account holds neither the
   * file's key nor the right to remove its blob.
   */
  async retryRevoke(file: StashFile): Promise<ReencryptResult> {
    const fileId = (file.file_id ?? file.fileId ?? file.id ?? file.d) as string | undefined
    const pending = fileId ? this.pendingRevoke(fileId) : null
    if (!pending) throw new Error('No unfinished re-encryption for this file')
    const fence = Keys.accountFence() ?? undefined
    if (!fence || fence.pubkey !== pending.pubkey) {
      throw new Error('Sign in with the account that started this re-encryption to finish it')
    }
    if (pending.stage === 'not-started') return this.revokeAndReencryptFile(file)
    return this.completeRevoke(pending, fence)
  },

  // Accept a shared file/folder.
  // Decrypts the shared key and stores it locally.
  async acceptShare(share: IncomingShare): Promise<AcceptedShareResult> {
    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    // Decrypt the share content (accepts NIP-04 legacy or NIP-44)
    const decryptedContent = await this.decryptFromSender(
      share.owner_pubkey,
      share.encrypted_content,
    )

    const content = JSON.parse(decryptedContent) as {
      type: string
      fileKey?: string
      fileId?: string
      fileName?: string
      fileSHA256?: string
      folderKey?: string
      folderId?: string
      folderName?: string
    }

    if (content.type === this.SHARE_TYPE_FILE && content.fileKey) {
      // Decrypt the file key (accepts NIP-04 legacy or NIP-44)
      const fileKeyHex = await this.decryptFromSender(share.owner_pubkey, content.fileKey)
      const fileKey = Crypto.hexToBytes(fileKeyHex)

      // Store the file key locally (associated with the share)
      await Keys.storeEncryptedKey(`share:${share.id}`, fileKey, content.fileId ?? null)

      console.log('Sharing: Accepted file share', share.id.slice(0, 8) + '...')

      return {
        type: this.SHARE_TYPE_FILE,
        fileId: content.fileId,
        fileName: content.fileName,
        sha256: content.fileSHA256,
      }
    } else if (content.type === this.SHARE_TYPE_FOLDER && content.folderKey) {
      // Decrypt the folder key (verbatim from legacy: computed but passed encrypted form to import)
      const folderKeyHex = await this.decryptFromSender(share.owner_pubkey, content.folderKey)
      const folderKey = Crypto.hexToBytes(folderKeyHex)
      void folderKey // unused per legacy logic; importSharedFolderKey re-decrypts internally

      // Import the shared folder key. A local key saved before provenance
      // existed is replaced only on positive proof that it came from this same
      // sender (their earlier share of this folder carried exactly that key).
      // No such share, or a relay error, is unknown, and unknown refuses.
      const folderId = content.folderId!
      const sender = share.owner_pubkey
      await Keys.importSharedFolderKey(folderId, content.folderKey, sender, {
        existingCameFromSender: (existingKeyHex) => this.senderSharedFolderKey(sender, folderId, existingKeyHex),
      })

      console.log('Sharing: Accepted folder share', share.id.slice(0, 8) + '...')

      return {
        type: this.SHARE_TYPE_FOLDER,
        folderId: content.folderId,
        folderName: content.folderName,
      }
    }

    throw new Error('Unknown share type')
  },

  /** Whether acceptShare has stored this share's key on this device (presence only, nothing decrypted). */
  async isShareAccepted(shareId: string, content: unknown): Promise<boolean> {
    const c = (content ?? {}) as { type?: string; folderId?: string }
    if (c.type === this.SHARE_TYPE_FILE) return Keys.hasStoredKey(`share:${shareId}`)
    if (c.type === this.SHARE_TYPE_FOLDER && c.folderId) return Keys.hasStoredKey(`folder:${c.folderId}`)
    return false
  },

  /**
   * Fetch and decrypt a file someone shared with us. The blob comes from our
   * own Blossom by the hash in the share, never from the URL the sender wrote
   * into it, and must match that hash.
   */
  async downloadSharedFile(share: DecryptedIncomingShare): Promise<SharedFileDownload> {
    const content = (share.content ?? {}) as Partial<ShareFileContent>
    if (!share.decrypted || content.type !== this.SHARE_TYPE_FILE || !content.fileSHA256) {
      throw new Error('Not a downloadable file share')
    }
    const sha256 = content.fileSHA256.toLowerCase()
    const response = await fetch(API.getDownloadURL(sha256))
    if (!response.ok) throw new Error(`Download failed: ${response.status}`)
    const stored = new Uint8Array(await response.arrayBuffer())
    if ((await Crypto.hash(stored)) !== sha256) {
      throw new Error('Shared file does not match its hash')
    }

    let data: Uint8Array = stored
    if (content.encrypted) {
      if (!content.fileKey) throw new Error('Share carries no file key')
      const key = Crypto.hexToBytes(await this.decryptFromSender(share.owner_pubkey, content.fileKey))
      try {
        data = await Crypto.decryptFile(stored, key)
      } finally {
        Crypto.wipeKey(key)
      }
    }
    return {
      data,
      name: content.fileName || 'shared-file',
      mimeType: content.fileMimeType || 'application/octet-stream',
    }
  },

  /** The folder id and key an incoming folder share carries. The caller wipes the key. */
  async sharedFolderKey(share: DecryptedIncomingShare): Promise<{ folderId: string; key: Uint8Array }> {
    const content = (share.content ?? {}) as Partial<ShareFolderContent>
    if (!share.decrypted || content.type !== this.SHARE_TYPE_FOLDER || !content.folderId || !content.folderKey) {
      throw new Error('Not a folder share')
    }
    const key = Crypto.hexToBytes(await this.decryptFromSender(share.owner_pubkey, content.folderKey))
    if (key.length !== 32) throw new Error('Folder share carries a malformed key')
    return { folderId: content.folderId, key }
  },

  /**
   * One level of a folder someone shared with us, read with the shared key:
   * the files that key opens and the subfolders it reaches (their keys are in
   * the snapshot, for browsing down).
   */
  async browseSharedFolder(owner: string, folderId: string, folderKey: Uint8Array): Promise<DriveSnapshot> {
    return listSharedFolder((filters) => Relay.query(filters), owner, folderId, folderKey)
  },

  /**
   * Fetch and decrypt a file listed by browseSharedFolder. The blob comes from
   * our own Blossom by the hash the owner signed and must match it. A blob the
   * key does not open throws SharedKeyCannotOpenError, never a bare AEAD error.
   * `mimeType` is the owner's claim: never use it as a blob type (saveAsDownload
   * always saves application/octet-stream).
   */
  async downloadFromSharedFolder(file: StashFile, key: Uint8Array): Promise<SharedFileDownload> {
    const name = file.name || 'shared-file'
    if (!file.sha256) throw new Error('File has no content hash')
    const sha256 = file.sha256.toLowerCase()
    const response = await fetch(API.getDownloadURL(sha256))
    if (!response.ok) throw new Error(`Download failed: ${response.status}`)
    const stored = new Uint8Array(await response.arrayBuffer())
    if ((await Crypto.hash(stored)) !== sha256) throw new Error('Shared file does not match its hash')
    let data: Uint8Array
    try {
      data = await Crypto.decryptFile(stored, key)
    } catch {
      throw new SharedKeyCannotOpenError(name)
    }
    return { data, name, mimeType: file.mime_type || 'application/octet-stream' }
  },

  /** The name and kind of an incoming share, read from its encrypted content (name null if unreadable). */
  async describeIncomingShare(share: IncomingShare): Promise<{ name: string | null; isFolder: boolean }> {
    try {
      const content = JSON.parse(await this.decryptFromSender(share.owner_pubkey, share.encrypted_content)) as {
        type?: string
        fileName?: string
        folderName?: string
      }
      const isFolder = content.type === this.SHARE_TYPE_FOLDER
      return { name: (isFolder ? content.folderName : content.fileName) || null, isFolder }
    } catch {
      return { name: null, isFolder: false }
    }
  },

  /** True only if `sender` has a folder share to us for `folderId` whose key is exactly `keyHex`. */
  async senderSharedFolderKey(sender: string, folderId: string, keyHex: string): Promise<boolean> {
    const me = authPort.pubkey
    if (!me) return false
    const events = await Relay.subscribe({ kinds: [30080], authors: [sender], '#p': [me] }, 5000)
    for (const event of events) {
      try {
        const content = JSON.parse(await this.decryptFromSender(sender, event.content as string)) as {
          type?: string
          folderId?: string
          folderKey?: string
        }
        if (content.type !== this.SHARE_TYPE_FOLDER || content.folderId !== folderId || !content.folderKey) continue
        if ((await this.decryptFromSender(sender, content.folderKey)) === keyHex) return true
      } catch {
        // undecryptable: not proof
      }
    }
    return false
  },

  // Create expiring share link with server-side validation.
  // baseUrl: caller supplies window.location.origin.
  async createExpiringLink(
    file: StashFile,
    baseUrl: string,
    expiresInSeconds: number,
    maxDownloads: number | null = null,
  ): Promise<PublicLinkResult> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds

    return this.generatePublicLink(file, baseUrl, {
      expiresAt: expiresAt,
      maxDownloads: maxDownloads,
    })
  },

  // Create time-limited share (allowance) — NIP-04/44 share with an expiry tag.
  async createTimedAllowance(
    file: StashFile,
    recipientPubkey: string,
    durationSeconds: number,
    options: ShareFileOptions = {},
  ): Promise<ShareResult> {
    const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds

    return this.shareFile(file, recipientPubkey, {
      ...options,
      expiresAt: expiresAt,
    })
  },

  // Query outgoing shares for a specific file/folder.
  // Fast path: local IndexedDB index (written at share-publish time).
  // Cold-start fallback: relay decrypt sweep with explicit limit, populating
  // the index as it goes. The sharer can decrypt their own records because
  // NIP-44/NIP-04 use a shared secret that both parties derive.
  async listOutgoingSharesForFile(
    targetId: string,
  ): Promise<Array<{ id: string; recipientPubkey: string; permission: string; expiresAt: number | null }>> {
    if (!authPort.isConnected || !authPort.pubkey) return []

    // Fast path: local index
    try {
      const cached = await queryShareIndex(targetId)
      if (cached.length > 0) return cached
    } catch {
      // IndexedDB unavailable; fall through to relay
    }

    // Cold-start fallback: decrypt sweep (bounded)
    const events = await Relay.subscribe(
      { kinds: [30080], authors: [authPort.pubkey], limit: 200 },
      10000,
    )

    const results: Array<{ id: string; recipientPubkey: string; permission: string; expiresAt: number | null }> = []
    for (const event of events) {
      const pTag = (event.tags as string[][])?.find((t) => t[0] === 'p')
      if (!pTag) continue

      try {
        const decrypted = await this.decryptFromSender(pTag[1], event.content as string)
        const content = JSON.parse(decrypted) as Record<string, unknown>
        const entryFileId = (content.fileId ?? content.folderId) as string | undefined
        const dTag = (event.tags as string[][])?.find((t) => t[0] === 'd')
        const entry = {
          id: dTag ? dTag[1] : (event.id as string),
          recipientPubkey: pTag[1],
          permission: (content.permission as string) ?? 'view',
          expiresAt: (content.expiresAt as number) ?? null,
        }

        // Populate local index for next time
        if (entryFileId) {
          void writeShareIndex({ ...entry, fileId: entryFileId, createdAt: (event.created_at as number) ?? 0 })
        }

        if (entryFileId === targetId) {
          results.push(entry)
        }
      } catch {
        // Undecryptable
      }
    }

    return results
  },

  // Query incoming share events (kind 30080) directly from the relay.
  // Returns IncomingShare records in the same shape the API returns, so
  // the decryption/accept flow downstream is unchanged.
  async queryIncomingSharesFromRelay(pubkey: string): Promise<IncomingShare[]> {
    const events = await Relay.subscribe(
      { kinds: [30080], '#p': [pubkey] },
      10000,
    )
    return events.map((event) => {
      const dTag = event.tags?.find((t: string[]) => t[0] === 'd')
      return {
        id: dTag ? dTag[1] : event.id,
        owner_pubkey: event.pubkey,
        encrypted_content: event.content,
      } as IncomingShare
    })
  },

  // List all shares received by the current user (decrypts each share's content).
  // Source of truth is the relay (kind 30080 addressed to this pubkey); the
  // server API is a fallback for when the relay is unreachable.
  async listIncomingShares(): Promise<DecryptedIncomingShare[]> {
    if (!authPort.isConnected) {
      return []
    }

    let shares: IncomingShare[]
    try {
      shares = await this.queryIncomingSharesFromRelay(authPort.pubkey!)
    } catch (relayErr) {
      console.warn('Sharing: Relay query failed, falling back to API:', (relayErr as Error).message)
      try {
        const response = (await API.listShares(
          authPort.pubkey!,
          'received',
        )) as unknown as { received?: IncomingShare[] }
        shares = response.received ?? []
      } catch (apiErr) {
        console.error('Sharing: Both relay and API failed:', (apiErr as Error).message)
        return []
      }
    }

    const decryptedShares: DecryptedIncomingShare[] = []
    for (const share of shares) {
      try {
        const decryptedContent = await this.decryptFromSender(
          share.owner_pubkey,
          share.encrypted_content,
        )
        const content = JSON.parse(decryptedContent) as unknown
        decryptedShares.push({
          ...share,
          content: content,
          decrypted: true,
          // A failed lookup reads as not accepted; it must not mark the share undecryptable.
          accepted: await this.isShareAccepted(share.id, content).catch(() => false),
        })
      } catch (err) {
        decryptedShares.push({
          ...share,
          decrypted: false,
          error: (err as Error).message,
        })
      }
    }

    return decryptedShares
  },

  // Check if a share has expired.
  isShareExpired(share: { expires_at?: number | null }): boolean {
    if (!share.expires_at) return false
    return share.expires_at < Math.floor(Date.now() / 1000)
  },

  // Format share expiration for display (human-readable remaining time).
  formatExpiration(expiresAt: number | null): string {
    if (!expiresAt) return 'Never'

    const now = Math.floor(Date.now() / 1000)
    const remaining = expiresAt - now

    if (remaining <= 0) return 'Expired'
    if (remaining < 60) return `${remaining}s`
    if (remaining < 3600) return `${Math.floor(remaining / 60)}m`
    if (remaining < 86400) return `${Math.floor(remaining / 3600)}h`
    return `${Math.floor(remaining / 86400)}d`
  },
}

export type SharingModule = typeof Sharing
export default Sharing
