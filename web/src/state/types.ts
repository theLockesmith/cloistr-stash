// Domain types for the stash file browser state.
// Modeled on the parsed server objects the legacy App consumed (app.js).

export type StashView = 'my-files' | 'shared' | 'starred' | 'recent' | 'trash'

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
