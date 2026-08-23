// Share dialog: NIP-44 share to a recipient pubkey, or generate a public link
// (key-in-URL) with optional expiry. Calls the ported sharing.ts directly.

import { useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import { Sharing } from '../lib/sharing'
import type { StashFile } from '../state/types'

const EXPIRY_OPTIONS = [
  { label: 'Never', value: 0 },
  { label: '1 day', value: 86400 },
  { label: '7 days', value: 7 * 86400 },
  { label: '30 days', value: 30 * 86400 },
  { label: '90 days', value: 90 * 86400 },
] as const

export function ShareModal({ file, onClose }: { file: StashFile | null; onClose: () => void }) {
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [expirySeconds, setExpirySeconds] = useState<number>(0)

  if (!file) return null

  const reset = () => {
    setRecipient('')
    setStatus(null)
    setLink(null)
    setBusy(false)
    setExpirySeconds(0)
  }

  const close = () => {
    reset()
    onClose()
  }

  const expiresAt = expirySeconds > 0 ? Math.floor(Date.now() / 1000) + expirySeconds : null

  const doShareToUser = async () => {
    const pubkey = recipient.trim()
    if (!pubkey) return
    setBusy(true)
    setStatus(null)
    try {
      await Sharing.shareFile(file, pubkey, { expiresAt })
      setStatus(`Shared with ${pubkey.slice(0, 12)}…${expiresAt ? ` (expires ${new Date(expiresAt * 1000).toLocaleDateString()})` : ''}`)
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
      const result = await Sharing.generatePublicLink(file, window.location.origin, { expiresAt })
      setLink(result.url)
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={!!file} onClose={close} title={`Share "${file.name}"`} size="sm">
      {/* Expiry selector — shared across both share methods */}
      <div className="share-section">
        <label className="share-label" htmlFor="share-expiry">
          Expires
        </label>
        <select
          id="share-expiry"
          className="modal-input"
          value={expirySeconds}
          onChange={(e) => setExpirySeconds(Number(e.target.value))}
        >
          {EXPIRY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

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
