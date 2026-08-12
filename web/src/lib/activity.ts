// Activity log – localStorage-backed client-side history.
//
// Ported from app.js: activityLog, ACTIVITY_STORAGE_KEY, MAX_ACTIVITY_ITEMS,
// logActivity(), loadActivityLog(), saveActivityLog(), getActivityIcon(),
// formatActivityText(), formatActivityTime(), clearActivityLog().
//
// Pure client-side: no backend calls, no Nostr events. The log persists in
// localStorage under 'cloistr-activity-log' exactly as the legacy app did so
// existing users retain their history after the React migration.

export type ActivityType =
  | 'upload'
  | 'download'
  | 'delete'
  | 'move'
  | 'share'
  | 'comment'
  | 'folder'
  | 'rename'
  | 'folder_rename'
  | 'login'
  | 'logout'

export interface ActivityEntry {
  id: string
  type: ActivityType
  details: Record<string, string>
  timestamp: number
}

const ACTIVITY_STORAGE_KEY = 'cloistr-activity-log'
const MAX_ACTIVITY_ITEMS = 500

function load(): ActivityEntry[] {
  try {
    const stored = localStorage.getItem(ACTIVITY_STORAGE_KEY)
    return stored ? (JSON.parse(stored) as ActivityEntry[]) : []
  } catch {
    return []
  }
}

function save(entries: ActivityEntry[]): void {
  try {
    const trimmed = entries.length > MAX_ACTIVITY_ITEMS ? entries.slice(-MAX_ACTIVITY_ITEMS) : entries
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(trimmed))
  } catch (e) {
    console.error('Failed to save activity log:', e)
  }
}

/** Append one entry to the log and persist. */
export function logActivity(type: ActivityType, details: Record<string, string> = {}): void {
  const entries = load()
  entries.push({ id: Date.now().toString(), type, details, timestamp: Date.now() })
  save(entries)
}

/** Return all entries, most-recent first, optionally filtered by type. */
export function getActivityEntries(filter: ActivityType | 'all' = 'all'): ActivityEntry[] {
  const entries = load()
  const reversed = [...entries].reverse()
  if (filter === 'all') return reversed
  return reversed.filter((e) => e.type === filter)
}

/** Erase the entire log from localStorage. */
export function clearActivity(): void {
  try {
    localStorage.removeItem(ACTIVITY_STORAGE_KEY)
  } catch {
    // ignore
  }
}

const ICONS: Record<string, string> = {
  upload: '📂',
  download: '📥',
  delete: '🗑️',
  move: '📁',
  share: '👥',
  comment: '💬',
  folder: '📁',
  rename: '✏️',
  folder_rename: '✏️',
  login: '🔒',
  logout: '🔓',
}

export function getActivityIcon(type: ActivityType): string {
  return ICONS[type] ?? '📄'
}

export function formatActivityText(entry: ActivityEntry): string {
  const d = entry.details
  switch (entry.type) {
    case 'upload':
      return `Uploaded ${d.name ?? 'file'}`
    case 'download':
      return `Downloaded ${d.name ?? 'file'}`
    case 'delete':
      return `Moved ${d.name ?? 'file'} to trash`
    case 'move':
      return `Moved ${d.name ?? 'file'} to ${d.destination ?? 'folder'}`
    case 'share':
      return `Shared ${d.name ?? 'file'}`
    case 'comment':
      return `Added comment to ${d.name ?? 'file'}`
    case 'folder':
      return `Created folder ${d.name ?? 'folder'}`
    case 'rename':
      return `Renamed ${d.oldName ?? 'file'} to ${d.newName ?? 'file'}`
    case 'folder_rename':
      return `Renamed folder ${d.oldName ?? 'folder'} to ${d.newName ?? 'folder'}`
    case 'login':
      return 'Logged in'
    case 'logout':
      return 'Logged out'
    default:
      return d.message ?? 'Unknown activity'
  }
}

export function formatActivityTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} minutes ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hours ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} days ago`
  return new Date(timestamp).toLocaleDateString()
}
