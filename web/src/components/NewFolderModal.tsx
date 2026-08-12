// New Folder modal — ported from the legacy #new-folder-modal flow.
//
// Always rendered in the DOM (never conditionally unmounted) so the spec
// can assert toBeAttached() + toHaveClass(/hidden/). Hidden state is
// communicated via the `hidden` CSS class rather than conditional rendering,
// matching the legacy approach in index.html / app.js (UI.showModal /
// UI.hideModal toggled the .hidden class on the same fixed div).

import { useEffect, useRef, useState } from 'react'
import { useStash } from '../state/useStash'

interface NewFolderModalProps {
  open: boolean
  onClose: () => void
}

export function NewFolderModal({ open, onClose }: NewFolderModalProps) {
  const { createFolder } = useStash()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset + focus when modal opens (mirrors legacy `input.value = ''; setTimeout(() => input.focus(), 100)`).
  useEffect(() => {
    if (open) {
      setName('')
      const t = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(t)
    }
  }, [open])

  // Close on Escape (mirrors legacy modal close behaviour).
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await createFolder(trimmed)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleCreate()
  }

  return (
    <div id="new-folder-modal" className={`modal${open ? '' : ' hidden'}`}>
      <div className="modal-content modal-small">
        <div className="modal-header">
          <h2>New Folder</h2>
          <button
            type="button"
            className="modal-close"
            id="new-folder-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-description">Create a new encrypted folder:</p>
          <input
            ref={inputRef}
            id="new-folder-name"
            className="input"
            type="text"
            placeholder="Folder name"
            autoComplete="off"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
          />
          <p className="modal-help">
            Folder contents will be encrypted with a unique key derived from your identity.
          </p>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn"
            id="new-folder-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            id="new-folder-create"
            onClick={() => void handleCreate()}
            disabled={busy || !name.trim()}
          >
            Create Folder
          </button>
        </div>
      </div>
    </div>
  )
}
