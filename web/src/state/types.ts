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

// File/folder domain types live in @cloistr/stash-core (the data layer owns them).
export type { StashFile, StashFolder, WrappedKeyEntry } from '@cloistr/stash-core/types'

export type SortField = 'name' | 'date' | 'size'
export type SortDir = 'asc' | 'desc'

export interface SortPrefs {
  field: SortField
  dir: SortDir
}
