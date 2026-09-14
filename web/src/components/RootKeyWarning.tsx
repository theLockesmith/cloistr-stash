import { useState, useEffect, useCallback } from 'react'
import { Keys } from '../lib/keys'

/**
 * Persistent warning banner shown when the root encryption key exists only in
 * this browser (the publish to the relay failed or was refused). Offers a retry
 * button and links to the backup modal as a fallback.
 *
 * This is the safety net for the silent-failure path in publishRootKeyToNostr:
 * without it, a relay refusal during key generation leaves the user with files
 * only this browser can decrypt, and no indication anything went wrong.
 */
export function RootKeyWarning({ onOpenBackup }: { onOpenBackup: () => void }) {
  const [localOnly, setLocalOnly] = useState(Keys.rootKeyLocalOnly)
  const [retrying, setRetrying] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return Keys.onRootKeyLocalOnlyChange(setLocalOnly)
  }, [])

  const handleRetry = useCallback(async () => {
    setRetrying(true)
    try {
      await Keys.retryPublishRootKey()
    } finally {
      setRetrying(false)
    }
  }, [])

  if (!localOnly || dismissed) return null

  return (
    <div
      className="root-key-warning"
      role="alert"
    >
      <div className="root-key-warning-icon" aria-hidden="true">⚠️</div>
      <div className="root-key-warning-body">
        <strong>Your encryption key is only saved in this browser.</strong>
        {' '}If you clear this browser's data or sign in from another device,
        your files will be unrecoverable. This happened because the key could
        not be published to the relay.
        <div className="root-key-warning-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleRetry}
            disabled={retrying}
          >
            {retrying ? 'Publishing…' : 'Retry publish'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onOpenBackup}
          >
            Download backup
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss warning"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
