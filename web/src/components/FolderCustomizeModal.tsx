// Folder customisation modal (ported from legacy app.js showFolderCustomizeModal /
// saveFolderCustomization / resetFolderCustomization and ui.js getFolderCustomization /
// setFolderCustomization / folderColors / folderIcons).
//
// Legacy behaviour:
//   • Modal opened via the "Customize" action button on any folder row/card.
//   • User picks a colour swatch (or "Default" = no colour override) and an
//     emoji icon (or "Default" = 📁). Choices are stored in localStorage under
//     the key 'cloistr-folder-customizations' as a map of folderId → {color, icon}.
//   • "Save" persists the selection; "Reset" clears both fields back to defaults.
//   • Applied live to FolderRow / FolderCard via the useFolderCustomizations hook.
//
// DOM shape intentionally matches tests/e2e/folder-operations.spec.js:
//   #folder-customize-modal  → always attached; class includes "hidden" when closed
//   h2                       → "Customize Folder"
//   #folder-customize-close  → close button
//   #customize-folder-name   → .folder-name-display
//   .customize-section[Color]→ contains #folder-color-picker.color-picker
//   .customize-section[Icon] → contains #folder-icon-picker.icon-picker
//   #folder-customize-save   → .btn-primary "Save"
//   #folder-customize-reset  → "Reset"

import { useCallback, useEffect, useState } from 'react'

// ─── Data ────────────────────────────────────────────────────────────────────

export interface FolderCustomization {
  color: string | null
  icon: string | null
}

export const FOLDER_COLORS: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
]

export const FOLDER_ICONS: { name: string; value: string }[] = [
  { name: 'Default', value: '📁' },
  { name: 'Open', value: '📂' },
  { name: 'Star', value: '⭐' },
  { name: 'Heart', value: '❤️' },
  { name: 'Work', value: '💼' },
  { name: 'Music', value: '🎵' },
  { name: 'Camera', value: '📷' },
  { name: 'Video', value: '🎬' },
  { name: 'Book', value: '📚' },
  { name: 'Code', value: '💻' },
  { name: 'Game', value: '🎮' },
  { name: 'Lock', value: '🔒' },
]

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'cloistr-folder-customizations'

function readStore(): Record<string, FolderCustomization> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, FolderCustomization>) : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, FolderCustomization>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (err) {
    console.error('FolderCustomizeModal: failed to save customizations', err)
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Reads folder customizations from localStorage and provides helpers to get and
 * set them.  The hook re-renders consumers when the store changes (via a
 * StorageEvent listener so cross-tab updates propagate too).
 */
export function useFolderCustomizations() {
  const [store, setStore] = useState<Record<string, FolderCustomization>>(readStore)

  // Refresh when another tab (or our own save) updates localStorage.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setStore(readStore())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const getCustomization = useCallback(
    (folderId: string): FolderCustomization => store[folderId] ?? { color: null, icon: null },
    [store],
  )

  const setCustomization = useCallback((folderId: string, color: string | null, icon: string | null) => {
    setStore((prev) => {
      const next = { ...prev }
      if (color === null && icon === null) {
        delete next[folderId]
      } else {
        next[folderId] = { color, icon }
      }
      writeStore(next)
      return next
    })
  }, [])

  return { getCustomization, setCustomization }
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface FolderCustomizeModalProps {
  /** Folder being customized, or null when the modal is closed. */
  folder: { id: string; name: string } | null
  onClose: () => void
  /** Called after a successful save or reset so the parent can refresh display. */
  onSaved: (folderId: string, color: string | null, icon: string | null) => void
}

export function FolderCustomizeModal({ folder, onClose, onSaved }: FolderCustomizeModalProps) {
  const isOpen = folder !== null
  const [selectedColor, setSelectedColor] = useState<string | null>(null)
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null)

  // When a new folder is opened, seed pickers from localStorage.
  useEffect(() => {
    if (!folder) return
    const current = readStore()[folder.id] ?? { color: null, icon: null }
    setSelectedColor(current.color)
    setSelectedIcon(current.icon)
  }, [folder])

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  function handleSave() {
    if (!folder) return
    const next = readStore()
    if (selectedColor === null && selectedIcon === null) {
      delete next[folder.id]
    } else {
      next[folder.id] = { color: selectedColor, icon: selectedIcon }
    }
    writeStore(next)
    onSaved(folder.id, selectedColor, selectedIcon)
    onClose()
  }

  function handleReset() {
    if (!folder) return
    const next = readStore()
    delete next[folder.id]
    writeStore(next)
    onSaved(folder.id, null, null)
    onClose()
  }

  // The modal is ALWAYS rendered so #folder-customize-modal is always attached to
  // the DOM. Playwright spec checks toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="folder-customize-modal" className={`modal${isOpen ? '' : ' hidden'}`} role="dialog" aria-modal="true" aria-labelledby="folder-customize-title">
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="folder-customize-title">Customize Folder</h2>
          <button
            type="button"
            className="modal-close"
            id="folder-customize-close"
            onClick={onClose}
            aria-label="Close folder customization"
          >
            &times;
          </button>
        </div>

        <div className="modal-body folder-customize-body">
          <div className="folder-name-display" id="customize-folder-name">
            {folder?.name ?? ''}
          </div>

          <div className="customize-section">
            <div className="customize-section-label">Color</div>
            <div className="color-picker" id="folder-color-picker">
              {FOLDER_COLORS.map((c) => {
                const isDefault = c.value === null
                const isSelected = c.value === selectedColor
                return (
                  <button
                    key={c.name}
                    type="button"
                    className={`color-swatch${isSelected ? ' selected' : ''}${isDefault ? ' default' : ''}`}
                    title={c.name}
                    aria-label={c.name}
                    aria-pressed={isSelected}
                    style={{ backgroundColor: c.value ?? '#888' }}
                    onClick={() => setSelectedColor(c.value)}
                  />
                )
              })}
            </div>
          </div>

          <div className="customize-section">
            <div className="customize-section-label">Icon</div>
            <div className="icon-picker" id="folder-icon-picker">
              {FOLDER_ICONS.map((ic) => {
                const isSelected = ic.value === (selectedIcon ?? '📁')
                return (
                  <button
                    key={ic.name}
                    type="button"
                    className={`icon-option${isSelected ? ' selected' : ''}`}
                    title={ic.name}
                    aria-label={ic.name}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedIcon(ic.name === 'Default' ? null : ic.value)}
                  >
                    {ic.value}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" id="folder-customize-reset" className="btn" onClick={handleReset}>
            Reset
          </button>
          <button type="button" id="folder-customize-save" className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
