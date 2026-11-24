// Share notifications, kept per account.
//
// They hold decrypted share names and the sender's key prefix, so they belong
// to the account that received them. They used to sit in one localStorage
// entry shared by every account on the browser; that entry is removed on load,
// never handed to whoever signs in next.

import type { IncomingShare } from '@cloistr/stash-core/sharing'
import type { StashNotification } from './types'

/** The old entry, shared by every account on the browser. Removed on load. */
export const LEGACY_NOTIFICATIONS_KEY = 'cloistr-notifications'

const keyFor = (pubkey: string) => `${LEGACY_NOTIFICATIONS_KEY}:${pubkey}`

/** The account's notifications; none when signed out. */
export function loadNotifications(pubkey: string | null): StashNotification[] {
  try {
    localStorage.removeItem(LEGACY_NOTIFICATIONS_KEY)
    if (!pubkey) return []
    const raw = localStorage.getItem(keyFor(pubkey))
    return raw ? (JSON.parse(raw) as StashNotification[]) : []
  } catch {
    return []
  }
}

/** Save under the account they belong to; nothing is saved when signed out. */
export function saveNotifications(pubkey: string | null, list: StashNotification[]): void {
  if (!pubkey) return
  try {
    localStorage.setItem(keyFor(pubkey), JSON.stringify(list))
  } catch (err) {
    console.warn('Failed to save notifications:', err)
  }
}

export interface ShareSummary {
  id: string
  owner_pubkey: string
  encrypted_content?: string
  name?: string
  isFolder?: boolean
}

/**
 * Notifications for shares this account has not been told about yet. Returns
 * null when the account changed during the check (`isCurrent` false after a
 * wait), so nothing from it reaches the next account.
 */
export async function findNewShareNotifications(opts: {
  pubkey: string
  existingShareIds: ReadonlySet<string>
  isCurrent: () => boolean
  listShares: (pubkey: string) => Promise<ShareSummary[]>
  describe: (share: IncomingShare) => Promise<{ name?: string | null; isFolder?: boolean }>
}): Promise<StashNotification[] | null> {
  const shares = await opts.listShares(opts.pubkey)
  if (!opts.isCurrent()) return null

  const found: StashNotification[] = []
  for (const share of shares) {
    if (opts.existingShareIds.has(share.id)) continue
    // The name is inside the encrypted content. Only new shares get here,
    // so the signer is not asked again on every poll.
    if (!share.name && share.encrypted_content) {
      const described = await opts.describe(share as IncomingShare)
      if (!opts.isCurrent()) return null
      share.name = described.name ?? undefined
      share.isFolder = share.isFolder ?? described.isFolder
    }
    const from =
      share.owner_pubkey && share.owner_pubkey.length > 8
        ? `${share.owner_pubkey.slice(0, 8)}…`
        : share.owner_pubkey || 'Someone'
    found.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      type: share.isFolder ? 'share_folder' : 'share_received',
      data: { shareId: share.id, name: share.name || 'Unknown', from },
      timestamp: Date.now(),
      read: false,
    })
  }
  return found
}
