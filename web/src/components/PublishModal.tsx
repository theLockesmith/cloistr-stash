// "Publish publicly" — the deliberate, per-file exception to zero-knowledge.
//
// This modal exists as much for its COPY as its behaviour. "Share link" and
// "Publish publicly" sound like the same feature and do opposite things:
//   Share link       stays encrypted; the key rides in the URL fragment, which
//                    is never sent to a server. We still cannot read it.
//   Publish publicly uploads an UNENCRYPTED copy. Anyone with the hash can read
//                    it — including us.
// Someone who picks the wrong one has published a private file to the internet,
// so the difference is stated plainly before anything is uploaded, not after.

import { useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import {
  getPlaintextBytes,
  publishPublicly,
  setProfilePicture,
  unpublish,
  type PublishResult,
} from '../lib/publish'
import type { StashFile } from '../state/types'

interface PublishModalProps {
  file: StashFile | null
  onClose: () => void
}

export function PublishModal({ file, onClose }: PublishModalProps) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (!file) return null

  const close = () => {
    setResult(null)
    setError(null)
    setNotice(null)
    setBusy(false)
    onClose()
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const doPublish = () =>
    run(async () => {
      setResult(await publishPublicly(file, getPlaintextBytes))
    })

  const doUnpublish = () =>
    run(async () => {
      if (!result) return
      await unpublish(result.sha256)
      setResult(null)
      // Deliberately NOT "removed everywhere". We stopped serving it; copies
      // already fetched by other clients are beyond our reach, and saying
      // otherwise would be a promise we cannot keep.
      setNotice(
        'Unpublished. We have stopped serving this file. Copies other apps already downloaded are outside our control.',
      )
    })

  const doSetPfp = () =>
    run(async () => {
      if (!result) return
      await setProfilePicture(result.url)
      setNotice('Your Nostr profile picture now points at this file.')
    })

  // Before publishing: a confirmation whose whole job is to prevent a mistake.
  if (!result) {
    return (
      <Modal
        isOpen
        onClose={close}
        title="Publish publicly?"
        footer={
          <>
            <button type="button" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="publish-danger" onClick={doPublish} disabled={busy}>
              {busy ? 'Publishing…' : 'Publish publicly'}
            </button>
          </>
        }
      >
        <div className="publish-warning">
            <p>
              <strong>This uploads an unencrypted copy of “{file.name || file.sha256}”.</strong>
            </p>
            <p>
              Anyone who has the link will be able to open it, and it will no longer be
              end-to-end encrypted. Cloistr will be able to read this copy.
            </p>
            <p>
              This is different from <strong>Share link</strong>, which keeps the file encrypted
              and puts the key in the link itself.
            </p>
            <p>
              Your original encrypted file stays exactly as it is. You can unpublish the public
              copy later — that stops us serving it, though copies other apps already downloaded
              are outside our control.
            </p>
          {error && <p className="publish-error">{error}</p>}
        </div>
      </Modal>
    )
  }

  // After publishing: the URL, and what you can do with it.
  return (
    <Modal
      isOpen
      onClose={close}
      title="Published"
      footer={
        <button type="button" onClick={close} disabled={busy}>
          Done
        </button>
      }
    >
      <div className="publish-result">
          <p>This file is now readable by anyone with the link:</p>
          <input
            className="publish-url"
            readOnly
            value={result.url}
            onFocus={e => e.currentTarget.select()}
            aria-label="Public file URL"
          />
          <div className="publish-actions">
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(result.url)}
              disabled={busy}
            >
              Copy link
            </button>
            <button type="button" onClick={doSetPfp} disabled={busy}>
              Use as Nostr profile picture
            </button>
            <button type="button" onClick={doUnpublish} disabled={busy}>
              Unpublish
            </button>
          </div>
        {notice && <p className="publish-notice">{notice}</p>}
        {error && <p className="publish-error">{error}</p>}
      </div>
    </Modal>
  )
}

export default PublishModal
