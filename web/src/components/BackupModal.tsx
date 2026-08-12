// Key Backup modal – ported from the legacy showBackupModal() / exportKeyBackup()
// / importKeyBackup() pipeline in app.js and Keys.exportBackup() / Keys.importBackup().
//
// Legacy behaviour reproduced here:
//   • Export – calls Keys.exportBackup(), serialises result as JSON, triggers a
//     browser file download named cloistr-stash-backup-<timestamp>.json.
//   • Import – reads a .json file, parses it, calls Keys.importBackup(). Reports
//     how many keys were imported.
//   • Status messages surface inline as #backup-status text.
//
// DOM structure intentionally matches the Playwright spec
// (tests/e2e/modals-features.spec.js):
//   #backup-modal        → always attached, class includes "hidden" when closed
//   .modal-header h2     → text "Key Backup"
//   #backup-modal-close  → × close button in header
//   #backup-export       → export section
//   #backup-import       → import section
//   #backup-file-input   → hidden file input (accept=".json")
//   #backup-export-btn   → "Download Backup"
//   #backup-import-btn   → "Select Backup File"
//   #backup-close        → "Close" button in footer
//   #backup-status       → inline status message
//
// Note: the file input is always accepted via the import button click; the native
// change handler fires importKeyBackup. Not ported: server-side key sync (not in
// the legacy either).

import { useRef, useState } from 'react'
import { Keys } from '../lib/keys'

type Status = { text: string; kind: 'idle' | 'info' | 'success' | 'error' }

const IDLE: Status = { text: '', kind: 'idle' }

export function BackupModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<Status>(IDLE)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetStatus = () => setStatus(IDLE)

  const handleClose = () => {
    resetStatus()
    onClose()
  }

  const exportKeyBackup = async () => {
    setStatus({ text: 'Generating backup…', kind: 'info' })
    try {
      const backup = await Keys.exportBackup()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cloistr-stash-backup-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setStatus({ text: 'Backup downloaded!', kind: 'success' })
    } catch (err) {
      setStatus({ text: `Backup failed: ${(err as Error).message}`, kind: 'error' })
    }
  }

  const importKeyBackup = async (file: File) => {
    setStatus({ text: 'Importing backup…', kind: 'info' })
    try {
      const text = await file.text()
      const backup = JSON.parse(text) as { encrypted: string; hash: string; pubkey: string }
      const result = await Keys.importBackup(backup)
      setStatus({ text: `Backup restored! Imported ${result.imported} of ${result.total} keys.`, kind: 'success' })
    } catch (err) {
      setStatus({ text: `Import failed: ${(err as Error).message}`, kind: 'error' })
    } finally {
      // Reset file input so the same file can be re-selected if needed.
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void importKeyBackup(file)
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  // The modal is ALWAYS rendered so #backup-modal is always attached to the DOM.
  // Playwright spec checks toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="backup-modal" className={`modal${isOpen ? '' : ' hidden'}`}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Key Backup</h2>
          <button
            type="button"
            className="modal-close"
            id="backup-modal-close"
            onClick={handleClose}
            aria-label="Close backup"
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div id="backup-export" className="backup-section">
            <h3>Export Keys</h3>
            <p className="modal-description">
              Download an encrypted backup of your encryption keys. You&apos;ll need your Nostr key to restore.
            </p>
            <button type="button" className="selection-btn primary" id="backup-export-btn" onClick={() => void exportKeyBackup()}>
              Download Backup
            </button>
          </div>

          <div id="backup-import" className="backup-section">
            <h3>Import Keys</h3>
            <p className="modal-description">Restore keys from a backup file.</p>
            <input
              ref={fileInputRef}
              type="file"
              id="backup-file-input"
              accept=".json"
              hidden
              onChange={handleFileChange}
            />
            <button type="button" className="selection-btn" id="backup-import-btn" onClick={handleImportClick}>
              Select Backup File
            </button>
          </div>

          <div
            id="backup-status"
            className={`share-status${status.kind === 'idle' ? ' hidden' : ''}`}
            aria-live="polite"
          >
            {status.text}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="selection-btn" id="backup-close" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
