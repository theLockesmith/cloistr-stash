// Manage Shares modal: lists outgoing NIP-44 shares for a file, allows
// per-share revocation and full re-encryption (revokeAndReencryptFile).
//
// Ported from the legacy app.js showManageSharesModal / revokeShare / rekeyFile
// functions. The underlying crypto and event logic lives in lib/sharing.ts and
// is called directly — no re-implementation here.

import { useEffect, useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import { Sharing } from '../lib/sharing'
import type { StashFile } from '../state/types'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape we extract from a raw outgoing share event. */
interface OutgoingShare {
  id: string
  tags?: [string, string][]
  // Backend-indexed fields (via server handleListShares → ShareResponse)
  file_id?: string
  recipient_pubkey?: string
  permission?: string
  expires_at?: number
  created_at?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the file identifier that was used to create the share. */
function fileIdOf(file: StashFile): string {
  return (file.id ||
    (file.file_id as string | undefined) ||
    (file.fileId as string | undefined) ||
    (file.d as string | undefined) ||
    file.sha256) as string
}

/**
 * Determine whether a share belongs to the given fileId.
 * The legacy used a 'file' tag; the backend-indexed shape exposes file_id.
 * We check both to be robust.
 */
function shareMatchesFile(share: OutgoingShare, fileId: string): boolean {
  // Prefer the backend's indexed file_id field
  if (share.file_id) {
    return share.file_id.includes(fileId) || fileId.includes(share.file_id)
  }
  // Fall back to the 'file' tag on the raw Nostr event
  const fileTag = share.tags?.find((t) => t[0] === 'file')
  return !!fileTag && fileTag[1]?.includes(fileId)
}

/** Pull recipient pubkey from the share, preferring the backend field. */
function recipientOf(share: OutgoingShare): string {
  if (share.recipient_pubkey) return share.recipient_pubkey
  const pTag = share.tags?.find((t) => t[0] === 'p')
  return pTag ? pTag[1] : 'Unknown'
}

/** Pull permission from the share. */
function permissionOf(share: OutgoingShare): string {
  if (share.permission) return share.permission
  const permTag = share.tags?.find((t) => t[0] === 'permission')
  return permTag ? permTag[1] : 'view'
}

/** Pull expiry unix timestamp from the share, or null. */
function expiresAtOf(share: OutgoingShare): number | null {
  if (share.expires_at) return share.expires_at
  const expTag = share.tags?.find((t) => t[0] === 'expiration')
  return expTag ? parseInt(expTag[1], 10) : null
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ManageSharesModal({
  file,
  onClose,
  onRekeyed,
}: {
  file: StashFile | null
  onClose: () => void
  /** Called after a successful re-encryption so the parent can refresh. */
  onRekeyed?: () => void
}) {
  const [shares, setShares] = useState<OutgoingShare[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [rekeying, setRekeying] = useState(false)

  // Load shares whenever the modal opens for a different file.
  useEffect(() => {
    let cancelled = false
    if (!file) {
      setShares([])
      setStatus(null)
      return
    }

    const fileId = fileIdOf(file)
    setLoading(true)
    setStatus(null)

    void Sharing.listOutgoingShares()
      .then((all) => {
        if (cancelled) return
        const fileShares = (all as OutgoingShare[]).filter((s) => shareMatchesFile(s, fileId))
        setShares(fileShares)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setStatus({ text: `Failed to load shares: ${msg}`, kind: 'error' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [file])

  if (!file) return null

  const close = () => {
    setStatus(null)
    onClose()
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  const revokeShare = async (shareId: string) => {
    if (!confirm('Revoke this share?')) return
    setRevoking(shareId)
    setStatus({ text: 'Revoking share…', kind: 'info' })
    try {
      await Sharing.revokeShare(shareId)
      setStatus({ text: 'Share revoked', kind: 'success' })
      // Refresh the list in place.
      setShares((prev) => prev.filter((s) => s.id !== shareId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus({ text: `Failed: ${msg}`, kind: 'error' })
    } finally {
      setRevoking(null)
    }
  }

  // ── Re-encrypt ────────────────────────────────────────────────────────────

  const rekeyFile = async () => {
    if (
      !confirm(
        `Re-encrypt "${file.name}"?\n\nThis will:\n- Generate a new encryption key\n- Re-upload the file encrypted with the new key\n- Invalidate all existing shares and public links\n\nThis cannot be undone.`,
      )
    ) {
      return
    }
    setRekeying(true)
    setStatus({ text: 'Re-encrypting file…', kind: 'info' })
    try {
      await Sharing.revokeAndReencryptFile(file)
      setStatus({ text: 'File re-encrypted with new key', kind: 'success' })
      setShares([])
      onRekeyed?.()
      setTimeout(close, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus({ text: `Re-encryption failed: ${msg}`, kind: 'error' })
    } finally {
      setRekeying(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const footer = (
    <button type="button" className="selection-btn" onClick={close}>
      Close
    </button>
  )

  return (
    <Modal isOpen={!!file} onClose={close} title="Manage Shares" size="md" footer={footer}>
      <p className="share-file-name">{file.name}</p>

      {/* Share list */}
      {loading ? (
        <div className="manage-shares-list">
          <div className="stash-muted">Loading shares…</div>
        </div>
      ) : shares.length === 0 ? (
        <div className="manage-shares-list">
          <div className="stash-muted">No active shares for this file.</div>
        </div>
      ) : (
        <ul className="manage-shares-list">
          {shares.map((share) => {
            const recipient = recipientOf(share)
            const permission = permissionOf(share)
            const expiresAt = expiresAtOf(share)
            const isExpired = expiresAt !== null && expiresAt < Math.floor(Date.now() / 1000)

            return (
              <li
                key={share.id}
                className={`manage-share-item${isExpired ? ' expired' : ''}`}
              >
                <span className="manage-share-info">
                  <span className="manage-share-recipient" title={recipient}>
                    {recipient.slice(0, 8)}…{recipient.slice(-8)}
                  </span>
                  <span className="manage-share-permission">{permission}</span>
                  <span className="manage-share-expiry">
                    {Sharing.formatExpiration(expiresAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className="selection-btn danger"
                  disabled={revoking === share.id || rekeying}
                  onClick={() => void revokeShare(share.id)}
                >
                  Revoke
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Re-encrypt section */}
      <div className="manage-shares-rekey">
        <h4>Revoke All Access</h4>
        <p className="stash-muted">
          Re-encrypt this file with a new key. All existing shares and public links will stop working.
        </p>
        <button
          type="button"
          className="selection-btn danger"
          disabled={rekeying || revoking !== null}
          onClick={() => void rekeyFile()}
        >
          Re-encrypt File
        </button>
      </div>

      {/* Status message */}
      {status && (
        <p className={`share-status${status.kind === 'error' ? ' error' : status.kind === 'success' ? ' success' : ''}`}>
          {status.text}
        </p>
      )}
    </Modal>
  )
}
