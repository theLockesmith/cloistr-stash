import type { PendingRevoke } from '@cloistr/stash-core/sharing'

const short = (pk: string) => `${pk.slice(0, 8)}…${pk.slice(-8)}`

/**
 * What Manage Shares says about a revoke that stopped partway, and whether it
 * can offer Retry. Above all it says whether the people the file was shared
 * with can still open it: an unfinished revoke must never read as done.
 */
export function revokeStatus(
  pending: PendingRevoke,
  currentPubkey: string | null | undefined,
): { text: string; canRetry: boolean } {
  const what =
    pending.stage === 'not-started'
      ? 'Re-encryption did not finish. It stopped before anything changed, so existing shares still work.'
      : pending.stage === 'old-copy-remains'
        ? 'Re-encryption did not finish. The new copy is saved, but the old copy is still stored, so people you shared this file with can still open it.'
        : 'Re-encryption did not finish. The old copy is gone, so old shares no longer open the file, but the share records were not withdrawn.'
  if (currentPubkey !== pending.pubkey) {
    return { text: `${what} Sign in with the account that started it (${short(pending.pubkey)}) to finish it.`, canRetry: false }
  }
  return { text: `${what} Retry to finish it.`, canRetry: true }
}
