// Batch-selection toolbar (ported from app.js bulkDelete UX). Appears when
// files/folders are selected; Delete opens a ConfirmModal, then soft-deletes
// files + batch-deletes folders via the store. Move opens a folder picker and
// moves all selected files (folders cannot be moved; no folder-move operation).

import { useState } from "react"
import { ConfirmModal } from "@cloistr/ui/components"
import { MoveModal } from "./MoveModal"
import { useStash } from "../state/useStash"

export function SelectionToolbar() {
  const { selectedFiles, selectedFolders, clearSelection, deleteSelected, moveSelected } = useStash()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)

  const fileCount = selectedFiles.size
  const folderCount = selectedFolders.size
  const total = fileCount + folderCount
  if (total === 0) return null

  const parts: string[] = []
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`)
  if (folderCount > 0) parts.push(`${folderCount} folder${folderCount > 1 ? "s" : ""}`)
  const description = parts.join(" and ")

  return (
    <div className="selection-toolbar" role="region" aria-label="Selection actions">
      <span className="selection-count">{total} selected</span>
      {fileCount > 0 && (
        <button type="button" className="selection-btn" onClick={() => setMoveOpen(true)}>
          Move
        </button>
      )}
      <button type="button" className="selection-btn danger" onClick={() => setConfirmOpen(true)}>
        Delete
      </button>
      <button type="button" className="selection-btn" onClick={clearSelection}>
        Clear
      </button>

      <MoveModal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        onMove={(targetFolderId) => {
          setMoveOpen(false)
          void moveSelected(targetFolderId)
        }}
      />
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          void deleteSelected()
        }}
        title="Delete selection"
        message={`Delete ${description}? Files move to Trash; folders are removed.`}
        confirmText="Delete"
      />
    </div>
  )
}
