// Migration modal: detects plaintext files in the current folder and offers to
// re-encrypt them in place (download -> encrypt -> re-upload -> delete original).
//
// Ported from the legacy `checkMigration()` + `migrateFiles()` pair in app.js
// (lines 5367-5425) and the `#migration-modal` HTML block in index.html.
//
// The legacy version had two gaps that are fixed here:
//   1. `Upload.uploadEncryptedFile` was undefined — upload.ts now exports
//      `uploadEncryptedBytes` which fills that role.
//   2. `checkMigration()` was never called from anywhere — the trigger is wired
//      into StashProvider after every `loadFiles()` resolves.
//
// Intentionally out of scope: migrating files across folders (the legacy code
// also only acted on `this.files` — the current folder's list), and migrating
// shared files (owner-only operation).

import { useState } from 'react'
import { Modal } from '@cloistr/ui/components'
import { API } from '../lib/api'
import { authPort } from '../lib/authBridge'
import { uploadEncryptedBytes } from '../lib/upload'
import type { StashFile } from '../state/types'

export interface MigrationModalProps {
  /** Plaintext files that should be migrated. Modal is open when this is non-empty. */
  unencryptedFiles: StashFile[]
  /** Current folder context for re-upload (empty string = root). */
  folderId: string
  onClose: () => void
  /** Called after migration completes so the caller can refresh the file list. */
  onComplete: () => void
}

export function MigrationModal({ unencryptedFiles, folderId, onClose, onComplete }: MigrationModalProps) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [done, setDone] = useState(false)

  const isOpen = unencryptedFiles.length > 0

  const handleClose = () => {
    if (running) return
    setDone(false)
    setProgress(0)
    setStatusText('')
    onClose()
  }

  const handleMigrateAll = async () => {
    if (running) return
    setRunning(true)
    setProgress(0)

    let migrated = 0
    let failed = 0

    for (let i = 0; i < unencryptedFiles.length; i++) {
      const file = unencryptedFiles[i]
      setStatusText(`Migrating ${file.name}…`)
      setProgress(Math.round(((i + 1) / unencryptedFiles.length) * 100))

      try {
        // 1. Download the plaintext blob.
        const downloadUrl = API.getDownloadURL(file.sha256)
        const response = await fetch(downloadUrl)
        if (!response.ok) throw new Error(`Download failed: ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())

        // 2. Re-upload encrypted.
        await uploadEncryptedBytes(
          data,
          file.name,
          file.mime_type || 'application/octet-stream',
          folderId || null,
        )

        // 3. Delete the original plaintext blob via Blossom delete auth.
        let deleteAuth: string | null = null
        if (authPort.isConnected) {
          deleteAuth = await authPort.createDeleteAuth(file.sha256)
        }
        await API.deleteFile(file.sha256, deleteAuth)

        migrated++
      } catch (err) {
        console.error(`Migration: failed to migrate "${file.name}":`, err)
        failed++
      }
    }

    setStatusText(
      failed > 0
        ? `Done: ${migrated} migrated, ${failed} failed`
        : `Done: ${migrated} file${migrated === 1 ? '' : 's'} encrypted`,
    )
    setProgress(100)
    setRunning(false)
    setDone(true)
    onComplete()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Migrate Files" size="sm">
      <p className="migration-description">
        You have {unencryptedFiles.length} unencrypted file{unencryptedFiles.length === 1 ? '' : 's'} that
        can be migrated to the encrypted format.
      </p>

      <ul className="migration-file-list">
        {unencryptedFiles.slice(0, 10).map((f) => (
          <li key={f.sha256}>{f.name}</li>
        ))}
        {unencryptedFiles.length > 10 && (
          <li>…and {unencryptedFiles.length - 10} more</li>
        )}
      </ul>

      {(running || done) && (
        <div className="migration-progress">
          <div className="migration-progress-track">
            <div className="migration-progress-bar" style={{ width: `${progress}%` }} />
          </div>
          <span className="migration-status">{statusText}</span>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="selection-btn" onClick={handleClose} disabled={running}>
          {done ? 'Close' : 'Cancel'}
        </button>
        {!done && (
          <button
            type="button"
            className="selection-btn primary"
            onClick={() => void handleMigrateAll()}
            disabled={running}
          >
            {running ? 'Migrating…' : 'Migrate All'}
          </button>
        )}
      </div>
    </Modal>
  )
}
