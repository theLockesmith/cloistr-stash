// Domain types shared by the Stash data layer and its consumers (web app, CLI).
// Modeled on the parsed server objects the legacy App consumed (app.js).

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
  /** User-defined tags for filtering/organisation (stored as Nostr 't' tags). */
  tags?: string[]
  /** File key wrapped (envelope-encrypted) to the owner's pubkey. Present after wrapped-key migration. */
  owner_key?: string
  [key: string]: unknown
}

export interface WrappedKeyEntry {
  subject: string
  envelope: string
}

export interface StashFolder {
  id: string
  name: string
  parent_id?: string
  description?: string
  /** Folder key, encrypted to the owner's pubkey (self-encryption). */
  encrypted_key?: string
  /** Member file keys wrapped under the folder key. Present after wrapped-key migration. */
  wrapped_keys?: WrappedKeyEntry[]
  [key: string]: unknown
}
