// Share dialog: NIP-44 share to a recipient pubkey, or generate a public link
// (key-in-URL). Calls the ported sharing.ts directly.

import { useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import { Sharing } from '../lib/sharing'
import type { StashFile } from '../state/types'

export function ShareModal({ file, onClose }: { file: StashFile | null; onClose: () => void }) {
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)

  if (!file) return null

  const reset = () => {
    setRecipient('')
    setStatus(null)
    setLink(null)
    setBusy(false)
  }

  const close = () => {
    reset()
    onClose()
  }

  const doShareToUser = async () => {
    const pubkey = recipient.trim()
    if (!pubkey) return
    setBusy(true)
    setStatus(null)
    try {
      await Sharing.shareFile(file, pubkey)
      setStatus(`Shared with ${pubkey.slice(0, 12)}…`)
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const doPublicLink = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await Sharing.generatePublicLink(file, window.location.origin)
      setLink(result.url)
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={!!file} onClose={close} title={`Share "${file.name}"`} size="sm">
      <div className="share-section">
        <label className="share-label" htmlFor="share-recipient">
          Share with a Nostr pubkey
        </label>
        <div className="share-row">
          <input
            id="share-recipient"
            className="modal-input"
            placeholder="npub… or hex pubkey"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          <button type="button" className="selection-btn primary" disabled={busy} onClick={doShareToUser}>
            Share
          </button>
        </div>
      </div>

      <div className="share-section">
        <label className="share-label">Public link (anyone with the link can decrypt)</label>
        <button type="button" className="selection-btn" disabled={busy} onClick={doPublicLink}>
          Generate public link
        </button>
        {link && (
          <input className="modal-input share-link" readOnly value={link} onFocus={(e) => e.target.select()} />
        )}
      </div>

      {status && <p className="share-status">{status}</p>}
    </Modal>
  )
}
