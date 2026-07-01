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
//   - Auth.createShareRevokeEvent()   → local helper (NIP-09 kind 5 via authPort.signEvent)
//   - Auth.createEncryptedFileMetadataEvent() → local helper (kind 30078)
//   - Auth.createDeleteAuth()         → local helper (Blossom kind 24242 t=delete)
//   - UI.toast()                      → dropped (pure UI; callers handle feedback)

import { Crypto } from './crypto'
import { Keys } from './keys'
import { API } from './api'
import { authPort } from './authBridge'
import type { UnsignedEvent, SignedEvent } from './relay'
import type { StashFile, StashFolder } from '../state/types'

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
}

// ─── Module-private helpers ───────────────────────────────────────────────────

function generateShareId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Crypto.bytesToHex(bytes)
}

async function createShareRevokeEvent(shareId: string): Promise<SignedEvent> {
  const event: UnsignedEvent = {
    kind: 5, // NIP-09 deletion
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', shareId]],
    content: 'Revoke share',
  }
  return authPort.signEvent(event)
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

    let fileKey: Uint8Array
    if (folderId) {
      fileKey = await Keys.deriveFileKey(folderId, fileId)
    } else {
      fileKey = await Keys.deriveRootFileKey(fileId)
    }

    // Encrypt the file key for the recipient using NIP-44
    const fileKeyHex = Crypto.bytesToHex(fileKey)
    const encryptedFileKey = await authPort.nip04Encrypt(recipientPubkey, fileKeyHex)

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
    await authPort.publishEvent(signedEvent)

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

    // Get the folder key
    const folderKey = await Keys.getFolderKey(folderId, folder.parent_id ?? null)

    // Encrypt the folder key for the recipient using NIP-44
    const folderKeyHex = Crypto.bytesToHex(folderKey)
    const encryptedFolderKey = await authPort.nip04Encrypt(recipientPubkey, folderKeyHex)

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
    await authPort.publishEvent(signedEvent)

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

    // Encrypt the entire share content for the recipient
    const contentJson = JSON.stringify(shareInfo.shareContent)
    const encryptedContent = await authPort.nip04Encrypt(shareInfo.recipientPubkey, contentJson)

    const event: UnsignedEvent = {
      kind: 30080, // Share kind
      created_at: now,
      tags: [
        ['d', shareInfo.id],
        ['p', shareInfo.recipientPubkey],
        ['permission', shareInfo.permission],
      ],
      content: encryptedContent,
    }

    // Add file/folder reference tag
    if (shareInfo.shareContent.type === this.SHARE_TYPE_FILE) {
      const c = shareInfo.shareContent as ShareFileContent
      event.tags.push(['file', `30078:${authPort.pubkey}:${c.fileId}`])
    } else if (shareInfo.shareContent.type === this.SHARE_TYPE_FOLDER) {
      const c = shareInfo.shareContent as ShareFolderContent
      event.tags.push(['folder', `30079:${authPort.pubkey}:${c.folderId}`])
    }

    // Add expiration if set
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

    // Get the file key
    let fileKey: Uint8Array
    if (folderId) {
      fileKey = await Keys.deriveFileKey(folderId, fileId)
    } else {
      fileKey = await Keys.deriveRootFileKey(fileId)
    }

    // Encode the key for URL fragment
    const keyBase64url = Crypto.bytesToBase64url(fileKey)

    // Build the public link URL
    // Format: https://stash.cloistr.xyz/public/{sha256}#{key}
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

      const signedEvent = await authPort.signEvent(event)
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

  // Revoke a share (publishes NIP-09 deletion event; clears cache entry).
  async revokeShare(shareId: string): Promise<boolean> {
    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    // Create deletion event (NIP-09)
    const signedEvent = await createShareRevokeEvent(shareId)

    // Publish to relay
    await authPort.publishEvent(signedEvent)

    // Remove from cache
    this.sharesCache.delete(shareId)

    console.log('Sharing: Revoked share', shareId.slice(0, 8) + '...')

    return true
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

    // UI.toast dropped (pure UI)

    // Step 1: Download the encrypted file
    const downloadUrl = API.getDownloadURL(file.sha256)
    const response = await fetch(downloadUrl)
    const encryptedData = await response.arrayBuffer()

    // Step 2: Decrypt with old key
    let oldFileKey: Uint8Array
    if (folderId) {
      oldFileKey = await Keys.deriveFileKey(folderId, fileId)
    } else {
      oldFileKey = await Keys.deriveRootFileKey(fileId)
    }

    const decryptedData = await Crypto.decryptFile(encryptedData, oldFileKey)

    // Step 3: Generate new file ID for fresh key derivation
    const newFileId = Crypto.generateFileId()

    // Step 4: Derive new file key
    let newFileKey: Uint8Array
    if (folderId) {
      newFileKey = await Keys.deriveFileKey(folderId, newFileId)
    } else {
      newFileKey = await Keys.deriveRootFileKey(newFileId)
    }

    // Step 5: Re-encrypt with new key
    const reencryptedData = await Crypto.encryptFile(decryptedData, newFileKey)

    // Step 6: Calculate new hash
    const newHash = await Crypto.hash(reencryptedData)

    // Step 7: Upload new encrypted blob
    const authHeader = await authPort.createUploadAuth(newHash, reencryptedData.length)
    const encryptedFile = new File([reencryptedData as BlobPart], file.name + '.encrypted', {
      type: 'application/octet-stream',
    })
    const uploadResult = (await API.uploadFile(encryptedFile, authHeader)) as { sha256: string }

    // Step 8: Publish new metadata event
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
    })
    await authPort.publishEvent(metadataEvent)

    // Step 9: Delete old file
    const deleteAuth = await createDeleteAuth(file.sha256)
    await API.deleteFile(file.sha256, deleteAuth)

    // Step 10: Revoke all existing shares (they're now useless anyway)
    // Note: In a full implementation, we'd query for shares and revoke them.
    // For now, old shares will simply fail to decrypt.

    // Cleanup
    Crypto.wipeKey(oldFileKey)
    Crypto.wipeKey(newFileKey)

    console.log('Sharing: File re-encrypted with new key')

    return {
      oldFileId: fileId,
      newFileId: newFileId,
      oldHash: file.sha256,
      newHash: uploadResult.sha256,
    }
  },

  // Accept a shared file/folder.
  // Decrypts the shared key and stores it locally.
  async acceptShare(share: IncomingShare): Promise<AcceptedShareResult> {
    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    // Decrypt the share content
    const decryptedContent = await authPort.nip04Decrypt(
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
      // Decrypt the file key
      const fileKeyHex = await authPort.nip04Decrypt(share.owner_pubkey, content.fileKey)
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
      const folderKeyHex = await authPort.nip04Decrypt(share.owner_pubkey, content.folderKey)
      const folderKey = Crypto.hexToBytes(folderKeyHex)
      void folderKey // unused per legacy logic; importSharedFolderKey re-decrypts internally

      // Import the shared folder key
      await Keys.importSharedFolderKey(content.folderId!, content.folderKey, share.owner_pubkey)

      console.log('Sharing: Accepted folder share', share.id.slice(0, 8) + '...')

      return {
        type: this.SHARE_TYPE_FOLDER,
        folderId: content.folderId,
        folderName: content.folderName,
      }
    }

    throw new Error('Unknown share type')
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

  // List all shares created by the current user.
  async listOutgoingShares(): Promise<unknown[]> {
    if (!authPort.isConnected) {
      return []
    }

    try {
      const response = (await API.listShares(
        authPort.pubkey!,
        'created',
      )) as unknown as { created?: unknown[] }
      return response.created ?? []
    } catch (err) {
      console.error('Sharing: Failed to list outgoing shares:', err)
      return []
    }
  },

  // List all shares received by the current user (decrypts each share's content).
  async listIncomingShares(): Promise<DecryptedIncomingShare[]> {
    if (!authPort.isConnected) {
      return []
    }

    try {
      const response = (await API.listShares(
        authPort.pubkey!,
        'received',
      )) as unknown as { received?: IncomingShare[] }
      const shares = response.received ?? []

      // Decrypt and parse share contents
      const decryptedShares: DecryptedIncomingShare[] = []
      for (const share of shares) {
        try {
          const decryptedContent = await authPort.nip04Decrypt(
            share.owner_pubkey,
            share.encrypted_content,
          )
          const content = JSON.parse(decryptedContent) as unknown
          decryptedShares.push({
            ...share,
            content: content,
            decrypted: true,
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
    } catch (err) {
      console.error('Sharing: Failed to list incoming shares:', err)
      return []
    }
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
