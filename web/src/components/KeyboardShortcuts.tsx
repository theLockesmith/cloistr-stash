// Global keyboard shortcuts (ported from app.js keydown handler) + the
// shortcuts help modal. Mounted once inside the authenticated app.
//
// Active subset (others depend on not-yet-ported features like upload/preview):
//   Esc       clear selection
//   ?         show this help
//   Ctrl/⌘+A  select all in view
//   Delete    delete selection (with confirm)

import { useEffect, useState } from 'react'
import { ConfirmModal, Modal } from '@cloistr/ui/components'
import { useStash } from '../state/useStash'

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: 'Esc', description: 'Clear selection' },
  { keys: '?', description: 'Show this help' },
  { keys: 'Ctrl / ⌘ + A', description: 'Select all in current view' },
  { keys: 'Delete / Backspace', description: 'Delete selection' },
]

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  return !!node && (node.matches?.('input, textarea, [contenteditable]') ?? false)
}

export function KeyboardShortcuts() {
  const { selectedFiles, selectedFolders, selectAll, clearSelection, deleteSelected } = useStash()
  const [helpOpen, setHelpOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const selectionCount = selectedFiles.size + selectedFolders.size

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }

      if (e.key === 'Escape') {
        if (selectionCount > 0) clearSelection()
        else {
          setHelpOpen(false)
          setConfirmOpen(false)
        }
        return
      }

      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const ctrl = isMac ? e.metaKey : e.ctrlKey

      switch (e.key) {
        case '?':
          e.preventDefault()
          setHelpOpen(true)
          break
        case 'a':
          if (ctrl) {
            e.preventDefault()
            selectAll()
          }
          break
        case 'Delete':
        case 'Backspace':
          if (selectionCount > 0 && !ctrl) {
            e.preventDefault()
            setConfirmOpen(true)
          }
          break
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectionCount, selectAll, clearSelection])

  return (
    <>
      <Modal isOpen={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" size="sm">
        <dl className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="shortcut-row">
              <dt>
                <kbd>{s.keys}</kbd>
              </dt>
              <dd>{s.description}</dd>
            </div>
          ))}
        </dl>
      </Modal>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          void deleteSelected()
        }}
        title="Delete selection"
        message={`Delete ${selectionCount} item${selectionCount === 1 ? '' : 's'}? Files move to Trash.`}
        confirmText="Delete"
      />
    </>
  )
}
