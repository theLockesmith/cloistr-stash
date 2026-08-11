// Global keyboard shortcuts (ported from app.js keydown handler + navigateFileList)
// + the shortcuts-help modal. Mounted once inside the authenticated workspace.
//
// Shortcuts ported from the legacy app.js keydown handler:
//   Esc         blur typing target / clear selection / close help
//   ?           show this help modal
//   /           focus the search input
//   u           trigger the upload file picker (clicks .upload-btn)
//   n           new folder (calls onNewFolder prop — no-op if not yet wired)
//   Ctrl/⌘+A   select all files + folders in view
//   Delete      soft-delete selected (confirmation via ConfirmModal)
//   d           download selected files (fetch + decrypt + anchor-click)
//   Enter       open selected file (calls onOpenSelected; falls back to download)
//   ↑ / ↓       navigate file/folder list (Shift extends selection)
//
// The help modal renders as an always-in-DOM div.modal with a toggled `hidden`
// class to satisfy the Playwright spec which uses toBeAttached() + toHaveClass(/hidden/).
// The ConfirmModal for delete still comes from @cloistr/ui (portal-rendered, not a spec
// structural target).

import { useEffect, useState } from 'react'
import { ConfirmModal } from '@cloistr/ui/components'
import { useStash } from '../state/useStash'
import type { StashFile, StashFolder } from '../state/types'
import { API } from '../lib/api'
import { Keys } from '../lib/keys'
import { Crypto } from '../lib/crypto'

export interface KeyboardShortcutsProps {
  /** Opens the new-folder modal. Wired when NewFolderModal is available. */
  onNewFolder?: () => void
  /** Opens a file for info / preview. Wired when that modal is in the tree.
   *  Falls back to download when not provided. */
  onOpenSelected?: (file: StashFile) => void
}

// Table rendered in the help modal.
// Keys and descriptions must match modals-features.spec.js assertions
// (shortcut-item contains a kbd with exact key text and a span with description text).
const SHORTCUTS: ReadonlyArray<{ key: string; description: string }> = [
  { key: '?',      description: 'Show this help' },
  { key: 'u',      description: 'Upload files' },
  { key: 'n',      description: 'New folder' },
  { key: '/',      description: 'Focus search' },
  { key: 'Esc',    description: 'Close modal / Clear selection' },
  { key: 'Delete', description: 'Delete selected files' },
  { key: 'd',      description: 'Download selected' },
  { key: 'Enter',  description: 'Open selected file' },
  { key: 'Ctrl+A', description: 'Select all' },
]

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  return !!node && (node.matches?.('input, textarea, [contenteditable]') ?? false)
}

// Fetch, optionally decrypt, and browser-download a single file.
// Mirrors the legacy App.downloadFile() pipeline (app.js).
async function triggerFileDownload(file: StashFile): Promise<void> {
  const res = await fetch(API.getDownloadURL(file.sha256))
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const buf = await res.arrayBuffer()

  const enc = !!(file.encrypted || (file as Record<string, unknown>).encryption)
  let data: Uint8Array
  if (enc) {
    const fileId = (
      file.id ??
      (file as Record<string, unknown>).file_id ??
      (file as Record<string, unknown>).fileId ??
      (file as Record<string, unknown>).d
    ) as string | undefined
    if (!fileId) throw new Error('Cannot decrypt: missing file ID')
    const folderId = file.folder as string | undefined
    const key = folderId
      ? await Keys.deriveFileKey(folderId, fileId)
      : await Keys.deriveRootFileKey(fileId)
    data = await Crypto.decryptFile(buf, key)
    Crypto.wipeKey(key)
  } else {
    data = new Uint8Array(buf)
  }

  const mimeType = (file.mime_type ?? 'application/octet-stream') as string
  // data is always backed by a regular ArrayBuffer (not SharedArrayBuffer);
  // the cast is safe here since Crypto never returns SharedArrayBuffer.
  const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mimeType })
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = file.name ?? file.sha256
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
}

export function KeyboardShortcuts({ onNewFolder, onOpenSelected }: KeyboardShortcutsProps) {
  const {
    files,
    folders,
    specialFiles,
    view,
    selectedFiles,
    selectedFolders,
    selectAll,
    clearSelection,
    deleteSelected,
    toggleFileSelection,
    toggleFolderSelection,
  } = useStash()

  const [helpOpen, setHelpOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const selectionCount = selectedFiles.size + selectedFolders.size

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Typing targets: Escape blurs them; all other shortcuts are suppressed.
      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }

      // Escape: close help → clear selection (matches legacy priority order).
      if (e.key === 'Escape') {
        if (helpOpen) {
          e.preventDefault()
          setHelpOpen(false)
          return
        }
        if (selectionCount > 0) {
          clearSelection()
          return
        }
        return
      }

      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const ctrl = isMac ? e.metaKey : e.ctrlKey

      switch (e.key) {
        case '?':
          e.preventDefault()
          setHelpOpen((o) => !o)
          break

        case '/':
          // Focus the search input, matching legacy behaviour.
          e.preventDefault()
          document.querySelector<HTMLElement>('input.search-input')?.focus()
          break

        case 'u':
          // Trigger the upload button (clicks the file picker).
          // Mirrors legacy: Upload.clear(); UI.showModal('upload-modal').
          if (!ctrl) {
            e.preventDefault()
            document.querySelector<HTMLElement>('.upload-btn')?.click()
          }
          break

        case 'n':
          // New folder — requires onNewFolder to be wired from App.tsx.
          if (!ctrl) {
            e.preventDefault()
            onNewFolder?.()
          }
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

        case 'd': {
          // Download each selected file.
          // Mirrors legacy App.bulkDownload() (app.js).
          if (!ctrl && selectedFiles.size > 0) {
            e.preventDefault()
            const pool = view === 'my-files' ? files : specialFiles
            for (const sha256 of selectedFiles) {
              const file = pool.find((f) => f.sha256 === sha256)
              if (file) void triggerFileDownload(file).catch(console.error)
            }
          }
          break
        }

        case 'Enter': {
          // Open / preview the first selected file.
          // Mirrors legacy: if previewable → showPreview; else → downloadFile.
          // Falls back to download when onOpenSelected is not wired.
          if (selectionCount > 0) {
            e.preventDefault()
            const sha256 = Array.from(selectedFiles)[0]
            if (sha256) {
              const pool = view === 'my-files' ? files : specialFiles
              const file = pool.find((f) => f.sha256 === sha256)
              if (file) {
                if (onOpenSelected) {
                  onOpenSelected(file)
                } else {
                  void triggerFileDownload(file).catch(console.error)
                }
              }
            }
          }
          break
        }

        case 'ArrowDown':
        case 'ArrowUp': {
          // Navigate through the file/folder list; Shift extends selection.
          // Mirrors legacy App.navigateFileList() (app.js).
          e.preventDefault()
          const navFolders: StashFolder[] = view === 'my-files' ? folders : []
          const navFiles: StashFile[] = view === 'my-files' ? files : specialFiles
          const allItems: (StashFile | StashFolder)[] = [...navFolders, ...navFiles]
          if (allItems.length === 0) break

          // Find the current anchor (last selected item in the combined list).
          let currentIndex = -1
          if (selectedFiles.size > 0) {
            const lastSha = Array.from(selectedFiles).pop()!
            currentIndex = allItems.findIndex(
              (item) => typeof (item as StashFile).sha256 === 'string' && (item as StashFile).sha256 === lastSha,
            )
          } else if (selectedFolders.size > 0) {
            const lastFolderId = Array.from(selectedFolders).pop()!
            currentIndex = allItems.findIndex(
              (item) =>
                typeof (item as StashFile).sha256 !== 'string' &&
                (item as StashFolder).id === lastFolderId,
            )
          }

          const direction = e.key === 'ArrowDown' ? 1 : -1
          const nextIndex = Math.max(0, Math.min(allItems.length - 1, currentIndex + direction))
          const target = allItems[nextIndex]
          if (!target) break

          // Without Shift: move selection; with Shift: extend.
          if (!e.shiftKey) clearSelection()
          const asFile = target as StashFile
          if (typeof asFile.sha256 === 'string' && asFile.sha256) {
            toggleFileSelection(asFile.sha256)
          } else {
            toggleFolderSelection((target as StashFolder).id)
          }

          // Scroll the newly focused row into view.
          setTimeout(() => {
            document.querySelector('.fb-row.selected')?.scrollIntoView({
              block: 'nearest',
              behavior: 'smooth',
            })
          }, 0)
          break
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    helpOpen,
    selectionCount,
    selectedFiles,
    selectedFolders,
    files,
    folders,
    specialFiles,
    view,
    selectAll,
    clearSelection,
    toggleFileSelection,
    toggleFolderSelection,
    onNewFolder,
    onOpenSelected,
  ])

  return (
    <>
      {/* Always-in-DOM modal so the Playwright spec can assert
          toBeAttached() + toHaveClass(/hidden/).
          Visibility is toggled via the `hidden` CSS class, matching
          the legacy UI.showModal / UI.hideModal pattern. */}
      <div id="keyboard-shortcuts-modal" className={`modal${helpOpen ? '' : ' hidden'}`}>
        <div className="modal-content modal-small">
          <div className="modal-header">
            <h2>Keyboard Shortcuts</h2>
            <button
              type="button"
              className="modal-close"
              id="keyboard-shortcuts-close"
              aria-label="Close keyboard shortcuts"
              onClick={() => setHelpOpen(false)}
            >
              &times;
            </button>
          </div>
          <div className="modal-body">
            <div className="shortcuts-list">
              {SHORTCUTS.map((s) => (
                <div key={s.key} className="shortcut-item">
                  <kbd>{s.key}</kbd>
                  <span>{s.description}</span>
                </div>
              ))}
              {/* Arrow navigation row: two kbd elements per legacy spec */}
              <div className="shortcut-item">
                <kbd>↑</kbd>
                {' '}
                <kbd>↓</kbd>
                <span>Navigate files</span>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-primary"
              id="keyboard-shortcuts-done"
              onClick={() => setHelpOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      </div>

      {/* Delete-selection confirmation (portal-rendered by @cloistr/ui). */}
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
