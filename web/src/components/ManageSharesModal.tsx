import { useEffect, useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import { Sharing } from '../lib/sharing'
import type { StashFile } from '../state/types'

interface OutgoingShareInfo {
  id: string
  recipientPubkey: string
  permission: string
  expiresAt: number | null
}

function fileIdOf(file: StashFile): string {
  return (file.id ||
    (file.file_id as string | undefined) ||
    (file.fileId as string | undefined) ||
    (file.d as string | undefined) ||
    file.sha256) as string
}

export function ManageSharesModal({
  file,
  onClose,
  onRekeyed,
}: {
  file: StashFile | null
  onClose: () => void
  onRekeyed?: () => void
}) {
  const [shares, setShares] = useState<OutgoingShareInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null)
  const [rekeying, setRekeying] = useState(false)

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

    void Sharing.listOutgoingSharesForFile(fileId)
      .then((results) => {
        if (cancelled) return
        setShares(results)
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

  const rekeyFile = async () => {
    if (
      !confirm(
        `Re-encrypt "${file.name}"?\n\n` +
          'This generates a new encryption key and re-uploads the file. ' +
          'ALL existing shares stop working — everyone loses access, ' +
          'including people who should keep it. ' +
          'You will need to re-share with anyone who should still have access.\n\n' +
          'This cannot be undone.',
      )
    ) {
      return
    }
    setRekeying(true)
    setStatus({ text: 'Re-encrypting file…', kind: 'info' })
    try {
      await Sharing.revokeAndReencryptFile(file)
      setStatus({ text: 'File re-encrypted with new key. All prior shares are invalid.', kind: 'success' })
      setShares([])
      onRekeyed?.()
      setTimeout(close, 2000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus({ text: `Re-encryption failed: ${msg}`, kind: 'error' })
    } finally {
      setRekeying(false)
    }
  }

  const footer = (
    <button type="button" className="selection-btn" onClick={close}>
      Close
    </button>
  )

  return (
    <Modal isOpen={!!file} onClose={close} title="Manage Shares" size="md" footer={footer}>
      <p className="share-file-name">{file.name}</p>

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
            const isExpired = share.expiresAt !== null && share.expiresAt < Math.floor(Date.now() / 1000)
            return (
              <li
                key={share.id}
                className={`manage-share-item${isExpired ? ' expired' : ''}`}
              >
                <span className="manage-share-info">
                  <span className="manage-share-recipient" title={share.recipientPubkey}>
                    {share.recipientPubkey.slice(0, 8)}…{share.recipientPubkey.slice(-8)}
                  </span>
                  <span className="manage-share-permission">{share.permission}</span>
                  <span className="manage-share-expiry">
                    {Sharing.formatExpiration(share.expiresAt)}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <div className="manage-shares-rekey">
        <h4>Revoke All Access</h4>
        <p className="stash-muted">
          Re-encrypt this file with a new key. Everyone loses access — including people who
          should keep it. You must re-share with each person afterward.
        </p>
        <button
          type="button"
          className="selection-btn danger"
          disabled={rekeying}
          onClick={() => void rekeyFile()}
        >
          Re-encrypt File
        </button>
      </div>

      {status && (
        <p className={`share-status${status.kind === 'error' ? ' error' : status.kind === 'success' ? ' success' : ''}`}>
          {status.text}
        </p>
      )}
    </Modal>
  )
}
