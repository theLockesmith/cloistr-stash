// File/folder browser surface (4b/4c): list + grid views of the active view.
//
// my-files shows the current folder's folders + files; starred/recent/trash
// show the special-view file set (no folders). Ported from ui.js
// renderFile/FolderListItem + grid variants, driven by the useStash store.
// Previews, context menus, drag-drop and batch ops land in 4d.

import { useState } from 'react'
import { useStash } from '../state/useStash'
import type { StashFile, StashFolder } from '../state/types'
import { formatDate, formatFileSize, getFileIcon } from './format'

type ViewMode = 'list' | 'grid'

function fileDisplayName(file: StashFile): string {
  return file.name || file.sha256.slice(0, 16) + '...'
}

function isEncrypted(file: StashFile): boolean {
  return !!(file.encrypted || (file as { encryption?: unknown }).encryption)
}

export function FileBrowser() {
  const {
    view,
    folders,
    files,
    specialFiles,
    loading,
    error,
    selectedFiles,
    selectedFolders,
    starredFiles,
    navigateToFolder,
    toggleFileSelection,
    toggleFolderSelection,
    toggleStar,
  } = useStash()
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  if (loading) return <div className="fb-status">Loading…</div>
  if (error) return <div className="fb-status fb-error">{error}</div>

  const isMyFiles = view === 'my-files'
  const shownFolders = isMyFiles ? folders : []
  const shownFiles = isMyFiles ? files : specialFiles
  const empty = shownFolders.length === 0 && shownFiles.length === 0

  const emptyMessage =
    view === 'trash'
      ? 'Trash is empty.'
      : view === 'starred'
        ? 'No starred files.'
        : view === 'recent'
          ? 'No recent files.'
          : 'This folder is empty.'

  return (
    <div className="file-browser">
      <div className="fb-toolbar" role="group" aria-label="View mode">
        <button
          type="button"
          className={`fb-view-btn ${viewMode === 'list' ? 'active' : ''}`}
          aria-pressed={viewMode === 'list'}
          onClick={() => setViewMode('list')}
        >
          ☰ List
        </button>
        <button
          type="button"
          className={`fb-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
          aria-pressed={viewMode === 'grid'}
          onClick={() => setViewMode('grid')}
        >
          ▦ Grid
        </button>
      </div>

      {empty ? (
        <div className="fb-status fb-empty">{emptyMessage}</div>
      ) : viewMode === 'list' ? (
        <div className="fb-list" role="list">
          {shownFolders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              selected={selectedFolders.has(folder.id)}
              onOpen={() => navigateToFolder(folder.id, folder.name)}
              onToggleSelect={() => toggleFolderSelection(folder.id)}
            />
          ))}
          {shownFiles.map((file) => (
            <FileRow
              key={file.sha256}
              file={file}
              selected={selectedFiles.has(file.sha256)}
              starred={starredFiles.has(file.sha256)}
              onToggleSelect={() => toggleFileSelection(file.sha256)}
              onToggleStar={() => toggleStar(file.sha256)}
            />
          ))}
        </div>
      ) : (
        <div className="fb-grid" role="list">
          {shownFolders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              onOpen={() => navigateToFolder(folder.id, folder.name)}
            />
          ))}
          {shownFiles.map((file) => (
            <FileCard key={file.sha256} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}

function FolderRow({
  folder,
  selected,
  onOpen,
  onToggleSelect,
}: {
  folder: StashFolder
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
}) {
  return (
    <div className={`fb-row fb-folder ${selected ? 'selected' : ''}`} role="listitem">
      <input
        type="checkbox"
        className="fb-checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${folder.name}`}
      />
      <button type="button" className="fb-name fb-folder-open" onClick={onOpen}>
        <span className="fb-icon" aria-hidden="true">
          📁
        </span>
        <span className="fb-name-text">{folder.name}</span>
      </button>
      <span className="fb-size">—</span>
      <span className="fb-date">—</span>
    </div>
  )
}

function FileRow({
  file,
  selected,
  starred,
  onToggleSelect,
  onToggleStar,
}: {
  file: StashFile
  selected: boolean
  starred: boolean
  onToggleSelect: () => void
  onToggleStar: () => void
}) {
  const enc = isEncrypted(file)
  const name = fileDisplayName(file)
  return (
    <div
      className={`fb-row fb-file ${selected ? 'selected' : ''} ${enc ? 'encrypted' : ''}`}
      role="listitem"
      aria-label={`${name}, ${formatFileSize(file.size)}${enc ? ', encrypted' : ''}${starred ? ', starred' : ''}`}
    >
      <input
        type="checkbox"
        className="fb-checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${name}`}
      />
      <span className="fb-name">
        <button
          type="button"
          className={`fb-star ${starred ? 'on' : ''}`}
          aria-pressed={starred}
          aria-label={starred ? 'Remove from starred' : 'Add to starred'}
          onClick={onToggleStar}
        >
          {starred ? '★' : '☆'}
        </button>
        <span className="fb-icon" aria-hidden="true">
          {getFileIcon(file.mime_type, enc)}
        </span>
        <span className="fb-name-text">{name}</span>
        {enc && (
          <span className="fb-e2e" title="End-to-end encrypted (XChaCha20-Poly1305)">
            E2E
          </span>
        )}
      </span>
      <span className="fb-size">{formatFileSize(file.size)}</span>
      <span className="fb-date">{formatDate(file.created_at as number | undefined)}</span>
    </div>
  )
}

function FolderCard({ folder, onOpen }: { folder: StashFolder; onOpen: () => void }) {
  return (
    <button type="button" className="fb-card fb-folder" onClick={onOpen} role="listitem">
      <span className="fb-card-icon" aria-hidden="true">
        📁
      </span>
      <span className="fb-card-name">{folder.name}</span>
    </button>
  )
}

function FileCard({ file }: { file: StashFile }) {
  const enc = isEncrypted(file)
  const name = fileDisplayName(file)
  return (
    <div className={`fb-card fb-file ${enc ? 'encrypted' : ''}`} role="listitem">
      <span className="fb-card-icon" aria-hidden="true">
        {getFileIcon(file.mime_type, enc)}
      </span>
      <span className="fb-card-name">{name}</span>
      <span className="fb-card-size">{formatFileSize(file.size)}</span>
    </div>
  )
}
