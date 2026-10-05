/**
 * File comments – localStorage-backed storage module.
 *
 * Storage design: comments are keyed by file sha256 and stored as JSON in
 * localStorage under STORAGE_KEY. This matches the legacy app.js behaviour
 * exactly (same key name, same shape).
 *
 * Tradeoff vs Nostr-native storage
 * ---------------------------------
 * localStorage (this implementation):
 *   + Matches legacy behaviour: private, zero-server-round-trips.
 *   + Simple module boundary: swap implementation without touching the UI.
 *   - Comments are device-local; not visible on other devices or to other users.
 *   - No sync, no backup.
 *
 * Nostr-native (NIP-XX kind:1 or similar, not implemented here):
 *   + Syncs across devices and relays; optionally shareable.
 *   + Aligns with the Nostr-native philosophy of the rest of the stack.
 *   - Requires relay round-trips; more complex error handling.
 *   - Comments would be at least semi-public unless NIP-44-encrypted.
 *
 * Operator decision: choose Nostr-native and swap this module when ready.
 * The UI (CommentsModal) only calls the four exported functions below, so the
 * swap is purely a lib/comments.ts replacement.
 */

export interface FileComment {
  id: string
  text: string
  timestamp: number
}

// Must match the legacy app.js constant so existing localStorage data migrates.
const STORAGE_KEY = 'cloistr-file-comments'

function load(): Record<string, FileComment[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, FileComment[]>) : {}
  } catch {
    return {}
  }
}

function save(store: Record<string, FileComment[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (err) {
    console.error('Failed to save comments:', err)
  }
}

/** Return all comments for a file, most-recent first by insertion order. */
export function getComments(sha256: string): FileComment[] {
  return load()[sha256] ?? []
}

/** Add a comment to a file. Returns the updated list. */
export function addComment(sha256: string, text: string): FileComment[] {
  const trimmed = text.trim()
  if (!trimmed) return getComments(sha256)

  const store = load()
  if (!store[sha256]) store[sha256] = []

  store[sha256].push({
    id: Date.now().toString(),
    text: trimmed,
    timestamp: Date.now(),
  })

  save(store)
  return store[sha256]
}

/** Delete a comment by id. Returns the updated list. */
export function deleteComment(sha256: string, commentId: string): FileComment[] {
  const store = load()
  if (!store[sha256]) return []

  store[sha256] = store[sha256].filter((c) => c.id !== commentId)
  if (store[sha256].length === 0) delete store[sha256]

  save(store)
  return store[sha256] ?? []
}

/** Count of comments for a file (for badge display). */
export function getCommentCount(sha256: string): number {
  return (load()[sha256] ?? []).length
}
