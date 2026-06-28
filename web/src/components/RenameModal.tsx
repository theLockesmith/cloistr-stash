// Rename dialog (ported from the rename-modal flow) using @cloistr/ui Modal.

import { useEffect, useState } from 'react'
import { Modal } from '@cloistr/ui/components'

export function RenameModal({
  open,
  initialName,
  title,
  onClose,
  onSave,
}: {
  open: boolean
  initialName: string
  title: string
  onClose: () => void
  onSave: (newName: string) => void
}) {
  const [name, setName] = useState(initialName)

  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])

  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const trimmed = name.trim()
          if (trimmed) onSave(trimmed)
        }}
      >
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New name"
          autoFocus
        />
        <div className="modal-actions">
          <button type="button" className="selection-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="selection-btn primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
