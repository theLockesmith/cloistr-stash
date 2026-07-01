// API client for communicating with the Stash backend.
//
// PORTED VERBATIM from legacy/js/api.js — same endpoints, headers, and request
// shapes (X-Blossom-Auth for blob ops, Authorization for metadata/folders/
// shares, X-Encryption mode on upload). Converted to a typed ESM singleton.

export type EncryptionMode = 'e2e' | 'server' | 'none'

/** Signed Nostr event passed to metadata/folder/share endpoints. */
export interface SignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface KeyringResponse {
  encrypted_root_key?: string
  [key: string]: unknown
}

export interface AuthStatus {
  authenticated?: boolean
  authorized?: boolean
  [key: string]: unknown
}

/** Permissive metadata shapes — server is source of truth; fields added as needed. */
export type FileMetadata = Record<string, unknown>
export type FolderMetadata = Record<string, unknown>
export type ShareInfo = Record<string, unknown>
export type QuotaInfo = Record<string, unknown>

// List endpoints return an object wrapping the array (server shape).
export interface FileListResponse {
  files: FileMetadata[]
}
export interface FolderListResponse {
  folders: FolderMetadata[]
}

export const API = {
  baseURL: '',

  // Upload a file with Blossom auth. encryptionMode: 'e2e' (default), 'server', or 'none'.
  async uploadFile(
    file: File | Blob,
    authHeader?: string | null,
    encryptionMode: EncryptionMode = 'e2e',
  ): Promise<FileMetadata> {
    const formData = new FormData()
    formData.append('file', file)

    const headers: Record<string, string> = {}
    if (authHeader) headers['X-Blossom-Auth'] = authHeader
    if (encryptionMode) headers['X-Encryption'] = encryptionMode

    const response = await fetch(`${this.baseURL}/api/files`, {
      method: 'POST',
      headers,
      body: formData,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Upload failed: ${response.status}`)
    }
    return response.json()
  },

  async listFiles(pubkey?: string): Promise<FileListResponse> {
    const url = pubkey ? `${this.baseURL}/api/files?pubkey=${pubkey}` : `${this.baseURL}/api/files`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to list files: ${response.status}`)
    return response.json()
  },

  async publishMetadata(signedEvent: SignedEvent, authHeader?: string | null): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authHeader) headers['Authorization'] = authHeader

    const response = await fetch(`${this.baseURL}/api/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedEvent),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Failed to publish metadata: ${response.status}`)
    }
    return response.json()
  },

  async getFile(id: string): Promise<FileMetadata> {
    const response = await fetch(`${this.baseURL}/api/files/${id}`)
    if (!response.ok) throw new Error(`Failed to get file: ${response.status}`)
    return response.json()
  },

  async deleteFile(sha256: string, authHeader?: string | null): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (authHeader) headers['X-Blossom-Auth'] = authHeader

    const response = await fetch(`${this.baseURL}/api/files/${sha256}`, { method: 'DELETE', headers })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Failed to delete file: ${response.status}`)
    }
    return response.json()
  },

  getDownloadURL(sha256: string): string {
    return `${this.baseURL}/api/files/${sha256}/download`
  },

  async health(): Promise<boolean> {
    const response = await fetch(`${this.baseURL}/health`)
    return response.ok
  },

  async checkAuthStatus(authHeader?: string | null): Promise<AuthStatus> {
    const headers: Record<string, string> = {}
    if (authHeader) headers['Authorization'] = authHeader

    const response = await fetch(`${this.baseURL}/api/auth/status`, { headers })
    console.log('API: checkAuthStatus response status:', response.status, response.statusText)
    console.log('API: checkAuthStatus content-type:', response.headers.get('content-type'))

    if (!response.ok) throw new Error(`Failed to check auth status: ${response.status}`)

    const text = await response.text()
    console.log('API: checkAuthStatus raw response (first 200 chars):', text.substring(0, 200))
    try {
      return JSON.parse(text)
    } catch (err) {
      console.error('API: Failed to parse auth status response:', (err as Error).message)
      console.error('API: Full response text:', text)
      throw err
    }
  },

  async listFolders(pubkey: string, parentId: string | null = null): Promise<FolderListResponse> {
    let url = `${this.baseURL}/api/folders?pubkey=${pubkey}`
    if (parentId !== null) url += `&parent=${parentId}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to list folders: ${response.status}`)
    return response.json()
  },

  async createFolder(signedEvent: SignedEvent, authHeader?: string | null): Promise<FolderMetadata> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authHeader) headers['Authorization'] = authHeader

    const response = await fetch(`${this.baseURL}/api/folders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedEvent),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Failed to create folder: ${response.status}`)
    }
    return response.json()
  },

  async getFolder(id: string, pubkey: string): Promise<FolderMetadata> {
    const response = await fetch(`${this.baseURL}/api/folders/${id}?pubkey=${pubkey}`)
    if (!response.ok) throw new Error(`Failed to get folder: ${response.status}`)
    return response.json()
  },

  async deleteFolder(id: string, signedEvent: SignedEvent, authHeader?: string | null): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authHeader) headers['Authorization'] = authHeader

    const response = await fetch(`${this.baseURL}/api/folders/${id}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify(signedEvent),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Failed to delete folder: ${response.status}`)
    }
    return response.json()
  },

  async listFilesInFolder(pubkey: string, folderId = ''): Promise<FileListResponse> {
    const url = `${this.baseURL}/api/files?pubkey=${pubkey}&folder=${folderId}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to list files: ${response.status}`)
    return response.json()
  },

  async listShares(pubkey: string, type = 'all'): Promise<ShareInfo[]> {
    const url = `${this.baseURL}/api/shares?pubkey=${pubkey}&type=${type}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to list shares: ${response.status}`)
    return response.json()
  },

  async createShare(signedEvent: SignedEvent, authHeader?: string | null): Promise<ShareInfo> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authHeader) headers['Authorization'] = authHeader

    const response = await fetch(`${this.baseURL}/api/shares`, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedEvent),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Failed to create share: ${response.status}`)
    }
    return response.json()
  },

  async revokeShare(shareId: string, signedEvent: SignedEvent, authHeader?: string | null): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authHeader) headers['Authorization'] = authHeader

    const response = await fetch(`${this.baseURL}/api/shares/${shareId}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify(signedEvent),
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `Failed to revoke share: ${response.status}`)
    }
    return response.json()
  },

  async getQuota(pubkey: string): Promise<QuotaInfo> {
    const response = await fetch(`${this.baseURL}/api/quota?pubkey=${pubkey}`)
    if (!response.ok) throw new Error(`Failed to get quota: ${response.status}`)
    return response.json()
  },

  // Get the user's encrypted root key from Nostr (satisfies keys.ts ApiPort).
  async getKeyring(pubkey: string): Promise<KeyringResponse> {
    const response = await fetch(`${this.baseURL}/api/keyring?pubkey=${pubkey}`)
    if (!response.ok) throw new Error(`Failed to get keyring: ${response.status}`)
    return response.json()
  },
}

export type ApiClient = typeof API
export default API
