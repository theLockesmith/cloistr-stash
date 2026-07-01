// File/folder browser surface (4b/4c/4d + #5 UI): list/grid views, per-row
// actions menu (info/share/versions/rename/move/delete), file-info/share/
// version-history/rename/move modals, batch selection toolbar, and the
// encrypted-search results view.

import { useState } from 'react'
import { ConfirmModal } from '@cloistr/ui/components'
import { useStash } from '../state/useStash'
import type { StashFile, StashFolder } from '../state/types'
import { formatDate, formatFileSize, getFileIcon } from './format'
import { FileInfoModal } from './FileInfoModal'
import { SelectionToolbar } from './SelectionToolbar'
import { RenameModal } from './RenameModal'
import { MoveModal } from './MoveModal'
import { ShareModal } from './ShareModal'
import { VersionHistoryModal } from './VersionHistoryModal'

type ViewMode = 'list' | 'grid'

function fileDisplayName(file: StashFile): string {
  return file.name || file.sha256.slice(0, 16) + '...'
}

function isEncrypted(file: StashFile): boolean {
  return !!(file.encrypted || (file as { encryption?: unknown }).encryption)
}

interface PendingDelete {
  kind: 'file' | 'folder'
  name: string
  file?: StashFile
  folderId?: string
}

interface RenameTarget {
  kind: 'file' | 'folder'
  name: string
  file?: StashFile
  folder?: StashFolder
}

export function FileBrowser() {
  const {
    view,
    folders,
    files,
    specialFiles,
    loading,
    error,
    searchResults,
    selectedFiles,
    selectedFolders,
    starredFiles,
    navigateToFolder,
    toggleFileSelection,
    toggleFolderSelection,
    toggleStar,
    recordFileAccess,
    deleteFile,
    deleteFolder,
    renameFile,
    renameFolder,
    moveFile,
    loadFiles,
    sharedItems,
    acceptShare,
  } = useStash()
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [infoFile, setInfoFile] = useState<StashFile | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<StashFile | null>(null)
  const [shareTarget, setShareTarget] = useState<StashFile | null>(null)
  const [versionTarget, setVersionTarget] = useState<StashFile | null>(null)

  const openInfo = (file: StashFile) => {
    recordFileAccess(file.sha256)
    setInfoFile(file)
  }

  // Modals are always mounted so they render regardless of the early returns below.
  const modals = (
    <>
      <FileInfoModal file={infoFile} onClose={() => setInfoFile(null)} />
      <ShareModal file={shareTarget} onClose={() => setShareTarget(null)} />
      <VersionHistoryModal
        file={versionTarget}
        onClose={() => setVersionTarget(null)}
        onRestored={() => void loadFiles()}
      />
      <RenameModal
        open={!!renameTarget}
        initialName={renameTarget?.name ?? ''}
        title={renameTarget?.kind === 'folder' ? 'Rename folder' : 'Rename file'}
        onClose={() => setRenameTarget(null)}
        onSave={(newName) => {
          const rt = renameTarget
          setRenameTarget(null)
          if (rt?.kind === 'file' && rt.file) void renameFile(rt.file, newName)
          else if (rt?.kind === 'folder' && rt.folder) void renameFolder(rt.folder, newName)
        }}
      />
      <MoveModal
        open={!!moveTarget}
        onClose={() => setMoveTarget(null)}
        onMove={(targetFolderId) => {
          const f = moveTarget
          setMoveTarget(null)
          if (f) void moveFile(f, targetFolderId)
        }}
      />
      <ConfirmModal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const pd = pendingDelete
          setPendingDelete(null)
          if (pd?.kind === 'file' && pd.file) void deleteFile(pd.file)
          else if (pd?.kind === 'folder' && pd.folderId) void deleteFolder(pd.folderId)
        }}
        title={pendingDelete?.kind === 'folder' ? 'Delete folder' : 'Delete file'}
        message={
          pendingDelete?.kind === 'folder'
            ? `Delete folder "${pendingDelete?.name}"?`
            : `Move "${pendingDelete?.name}" to Trash?`
        }
        confirmText="Delete"
      />
    </>
  )

  const fileMenuItems = (file: StashFile) => [
    { label: 'Info', onClick: () => openInfo(file) },
    { label: 'Share', onClick: () => setShareTarget(file) },
    { label: 'Versions', onClick: () => setVersionTarget(file) },
    { label: 'Rename', onClick: () => setRenameTarget({ kind: 'file', file, name: fileDisplayName(file) }) },
    { label: 'Move to…', onClick: () => setMoveTarget(file) },
    {
      label: 'Delete',
      onClick: () => setPendingDelete({ kind: 'file', file, name: fileDisplayName(file) }),
      danger: true,
    },
  ]

  // --- Search results view ---
  if (searchResults !== null) {
    return (
      <div className="file-browser">
        {searchResults.length === 0 ? (
          <div className="fb-status fb-empty">No matches.</div>
        ) : (
          <div className="fb-list" role="list">
            {searchResults.map((r) => {
              const asFile: StashFile = {
                sha256: r.sha256,
                name: r.name,
                mime_type: r.mimeType,
                id: r.fileId,
                encrypted: true,
              }
              return (
                <div key={r.fileId} className="fb-row fb-file" role="listitem">
                  <span className="fb-checkbox" />
                  <button type="button" className="fb-name" onClick={() => openInfo(asFile)}>
                    <span className="fb-icon" aria-hidden="true">
                      {getFileIcon(r.mimeType, true)}
                    </span>
                    <span className="fb-name-text">{r.name}</span>
                  </button>
                  <span className="fb-size">{formatFileSize(r.size)}</span>
                  <span className="fb-date">score {r.score.toFixed(1)}</span>
                  <RowMenu label={`Actions for ${r.name}`} items={fileMenuItems(asFile)} />
                </div>
              )
            })}
          </div>
        )}
        {modals}
      </div>
    )
  }

  if (loading) return <div className="fb-status">Loading…{modals}</div>
  if (error) return <div className="fb-status fb-error">{error}{modals}</div>

  // --- Shared (incoming shares) view ---
  if (view === 'shared') {
    return (
      <div className="file-browser">
        {sharedItems.length === 0 ? (
          <div className="fb-status fb-empty">No shares received.</div>
        ) : (
          <ul className="shared-list">
            {sharedItems.map((share) => {
              const content = (share.content ?? {}) as {
                fileName?: string
                folderName?: string
                type?: string
              }
              const name = content.fileName || content.folderName || `Shared ${content.type || 'item'}`
              return (
                <li key={share.id} className="shared-row">
                  <span className="shared-meta">
                    <span className="fb-icon" aria-hidden="true">
                      {content.folderName ? '📁' : '🔒'}
                    </span>
                    {name}
                    <span className="shared-from">from {share.owner_pubkey.slice(0, 12)}…</span>
                    {!share.decrypted && <span className="fb-e2e">undecryptable</span>}
                  </span>
                  <button
                    type="button"
                    className="selection-btn primary"
                    disabled={!share.decrypted}
                    onClick={() => void acceptShare(share)}
                  >
                    Accept
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {modals}
      </div>
    )
  }

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
      <SelectionToolbar />

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
              onRename={() => setRenameTarget({ kind: 'folder', folder, name: folder.name })}
              onDelete={() => setPendingDelete({ kind: 'folder', folderId: folder.id, name: folder.name })}
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
              onInfo={() => openInfo(file)}
              menuItems={fileMenuItems(file)}
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
            <FileCard key={file.sha256} file={file} onInfo={() => openInfo(file)} />
          ))}
        </div>
      )}

      {modals}
    </div>
  )
}

interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

/** Lightweight per-row actions menu (⋮) with a click-away overlay. */
function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="fb-menu">
      <button
        type="button"
        className="fb-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        ⋮
      </button>
      {open && (
        <>
          <button type="button" className="fb-menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <span className="fb-menu-list" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`fb-menu-item ${item.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  item.onClick()
                }}
              >
                {item.label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

function FolderRow({
  folder,
  selected,
  onOpen,
  onToggleSelect,
  onRename,
  onDelete,
}: {
  folder: StashFolder
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onRename: () => void
  onDelete: () => void
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
      <RowMenu
        label={`Actions for ${folder.name}`}
        items={[
          { label: 'Rename', onClick: onRename },
          { label: 'Delete', onClick: onDelete, danger: true },
        ]}
      />
    </div>
  )
}

function FileRow({
  file,
  selected,
  starred,
  onToggleSelect,
  onToggleStar,
  onInfo,
  menuItems,
}: {
  file: StashFile
  selected: boolean
  starred: boolean
  onToggleSelect: () => void
  onToggleStar: () => void
  onInfo: () => void
  menuItems: MenuItem[]
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
        <button type="button" className="fb-name-text fb-name-btn" onClick={onInfo}>
          {name}
        </button>
        {enc && (
          <span className="fb-e2e" title="End-to-end encrypted (XChaCha20-Poly1305)">
            E2E
          </span>
        )}
      </span>
      <span className="fb-size">{formatFileSize(file.size)}</span>
      <span className="fb-date">{formatDate(file.created_at as number | undefined)}</span>
      <RowMenu label={`Actions for ${name}`} items={menuItems} />
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

function FileCard({ file, onInfo }: { file: StashFile; onInfo: () => void }) {
  const enc = isEncrypted(file)
  const name = fileDisplayName(file)
  return (
    <button type="button" className={`fb-card fb-file ${enc ? 'encrypted' : ''}`} role="listitem" onClick={onInfo}>
      <span className="fb-card-icon" aria-hidden="true">
        {getFileIcon(file.mime_type, enc)}
      </span>
      <span className="fb-card-name">{name}</span>
      <span className="fb-card-size">{formatFileSize(file.size)}</span>
    </button>
  )
}
