// The Recent list: files touched on this device (opened, previewed, uploaded),
// newest first. Kept in localStorage under 'cloistr-recent' (legacy key).

export interface RecentEntry {
  sha256: string
  accessedAt: number
}

export const RECENT_LIMIT = 100

/** `recent` with `sha256s` moved to the front, stamped `now` (seconds). */
export function withAccess(recent: RecentEntry[], sha256s: string[], now: number): RecentEntry[] {
  const touched = [...new Set(sha256s.filter(Boolean))]
  const rest = recent.filter((r) => !touched.includes(r.sha256))
  return [...touched.map((sha256) => ({ sha256, accessedAt: now })), ...rest].slice(0, RECENT_LIMIT)
}
