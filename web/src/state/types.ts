// Domain types for the stash file browser state.
// Modeled on the parsed server objects the legacy App consumed (app.js).

export type StashView = 'my-files' | 'shared' | 'starred' | 'recent' | 'trash'

// ---------------------------------------------------------------------------
// Notification types (ported from app.js NOTIFICATIONS_STORAGE_KEY / addNotification)
// ---------------------------------------------------------------------------

export type NotificationType = 'share_received' | 'share_folder'

export interface StashNotification {
  /** Unique id (Date.now().toString() in the original). */
  id: string
  type: NotificationType
  /** Opaque payload: shareId, name, from (truncated pubkey). */
  data: {
    shareId: string
    name: string
    from: string
  }
  /** Unix ms timestamp. */
  timestamp: number
  read: boolean
  /** Set to true when the user clicks Accept (localStorage-only, no backend call). */
  accepted?: boolean
  /** Set to true when the user clicks Decline. */
  declined?: boolean
}

export interface FolderPathItem {
  id: string
  name: string
}

export interface StashFile {
  sha256: string
  /** File id / d-tag used for key derivation. */
  id?: string
  name: string
  size?: number
  mime_type?: string
  encrypted_size?: number
  encrypted?: boolean
  /** Owning folder id ('' / undefined = root). */
  folder?: string
  deleted_at?: number
  deletedAt?: number
  [key: string]: unknown
}

export interface StashFolder {
  id: string
  name: string
  parent_id?: string
  description?: string
  /** Folder key, encrypted to the owner's pubkey (self-encryption). */
  encrypted_key?: string
  [key: string]: unknown
}
