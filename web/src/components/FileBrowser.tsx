// File/folder browser surface (4b/4c/4d + #5 UI): list/grid views, per-row
// actions menu (info/share/versions/rename/move/delete), file-info/share/
// version-history/rename/move modals, batch selection toolbar, and the
// encrypted-search results view.
//
// Context menu: right-click (or ⋮ button) on file/folder rows opens a fixed-position
// menu (#context-menu) that mirrors the legacy vanilla-JS UI's showFileContextMenu /
// showContextMenu behaviour.  Items are the same set as the inline RowMenu.
// Touch long-press and the extended legacy items (Tags, Comments, Public Link,
// Manage Shares, Encryption Info, Collaborative Edit) are not ported — each is a
// separate feature tracked independently.

import { useState, useEffect, useCallback } from 'react'
import { ConfirmModal } from '@cloistr/ui/components'
import { useStash } from '../state/useStash'
import type { StashFile, StashFolder } from '../state/types'
import { formatDate, formatFileSize, getFileIcon } from './format'
import { FileInfoModal } from './FileInfoModal'
import { EditorModal } from './EditorModal'
import { EncryptionInfoModal } from './EncryptionInfoModal'
import { PreviewModal } from './PreviewModal'
import { SelectionToolbar } from './SelectionToolbar'
import { RenameModal } from './RenameModal'
import { MoveModal } from './MoveModal'
import { ShareModal } from './ShareModal'
import { ManageSharesModal } from './ManageSharesModal'
import { VersionHistoryModal } from './VersionHistoryModal'
import { Collaboration } from '../lib/collaboration'
import { CommentsModal } from './CommentsModal'
import { FolderCustomizeModal, useFolderCustomizations } from './FolderCustomizeModal'
import { PublishModal } from './PublishModal'
import type { FolderCustomization } from './FolderCustomizeModal'

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

interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
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
  const [encInfoFile, setEncInfoFile] = useState<StashFile | null>(null)
  const [previewFile, setPreviewFile] = useState<StashFile | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<StashFile | null>(null)
  const [shareTarget, setShareTarget] = useState<StashFile | null>(null)
  const [manageSharesTarget, setManageSharesTarget] = useState<StashFile | null>(null)
  const [versionTarget, setVersionTarget] = useState<StashFile | null>(null)
  const [editorTarget, setEditorTarget] = useState<StashFile | null>(null)
  const [commentsTarget, setCommentsTarget] = useState<StashFile | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // File being published publicly (null = modal closed).
  const [publishTarget, setPublishTarget] = useState<StashFile | null>(null)
  // Folder being customized (null = modal closed).
  const [customizeFolder, setCustomizeFolder] = useState<{ id: string; name: string } | null>(null)

  const { getCustomization, setCustomization } = useFolderCustomizations()

  const openInfo = (file: StashFile) => {
    recordFileAccess(file.sha256)
    setInfoFile(file)
  }

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  /**
   * Open the context menu at the mouse coordinates from a contextmenu event.
   * Mirrors the legacy showContextMenu(x, y, items) viewport-clipping logic.
   */
  const openContextMenu = useCallback(
    (e: React.MouseEvent, items: MenuItem[]) => {
      e.preventDefault()
      e.stopPropagation()
      // Approximate menu dimensions for edge-clamping (matches legacy heuristic).
      const MENU_W = 170
      const MENU_H = items.length * 36 + 16
      const x = Math.max(10, Math.min(e.clientX, window.innerWidth - MENU_W - 10))
      const y = Math.max(10, Math.min(e.clientY, window.innerHeight - MENU_H - 10))
      setContextMenu({ x, y, items })
    },
    [],
  )

  // Modals are always mounted so they render regardless of the early returns below.
  const modals = (
    <>
      <FileInfoModal
          file={infoFile}
          onClose={() => setInfoFile(null)}
          onPreview={(f) => { setInfoFile(null); setPreviewFile(f) }}
          onShare={(f) => setShareTarget(f)}
          onVersions={(f) => setVersionTarget(f)}
          onDelete={(f) => setPendingDelete({ kind: 'file', file: f, name: fileDisplayName(f) })}
        />
      <EncryptionInfoModal file={encInfoFile} onClose={() => setEncInfoFile(null)} />
      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      <EditorModal file={editorTarget} onClose={() => setEditorTarget(null)} />
      <ShareModal file={shareTarget} onClose={() => setShareTarget(null)} />
      <ManageSharesModal
        file={manageSharesTarget}
        onClose={() => setManageSharesTarget(null)}
        onRekeyed={() => void loadFiles()}
      />
      <VersionHistoryModal
        file={versionTarget}
        onClose={() => setVersionTarget(null)}
        onRestored={() => void loadFiles()}
      />
      <CommentsModal file={commentsTarget} onClose={() => setCommentsTarget(null)} />
      <PublishModal file={publishTarget} onClose={() => setPublishTarget(null)} />
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
      <FolderCustomizeModal
        folder={customizeFolder}
        onClose={() => setCustomizeFolder(null)}
        onSaved={(folderId, color, icon) => setCustomization(folderId, color, icon)}
      />
    </>
  )

  const fileMenuItems = (file: StashFile): MenuItem[] => [
    { label: 'Info', onClick: () => openInfo(file) },
    ...(Collaboration.isCollaborativeFileType(file.mime_type)
      ? [{ label: 'Edit', onClick: () => setEditorTarget(file) }]
      : []),
    { label: 'Preview', onClick: () => setPreviewFile(file) },
    { label: 'Encryption Info', onClick: () => setEncInfoFile(file) },
    { label: 'Share', onClick: () => setShareTarget(file) },
    { label: 'Manage Shares', onClick: () => setManageSharesTarget(file) },
    // Distinct from 'Share' directly above: this one publishes an UNENCRYPTED
    // copy. The label says 'publicly' because the two actions sound alike and
    // have opposite privacy properties.
    { label: 'Publish publicly…', onClick: () => setPublishTarget(file) },
    { label: 'Versions', onClick: () => setVersionTarget(file) },
    { label: 'Comments', onClick: () => setCommentsTarget(file) },
    { label: 'Rename', onClick: () => setRenameTarget({ kind: 'file', file, name: fileDisplayName(file) }) },
    { label: 'Move to…', onClick: () => setMoveTarget(file) },
    {
      label: 'Delete',
      onClick: () => setPendingDelete({ kind: 'file', file, name: fileDisplayName(file) }),
      danger: true,
    },
  ]

  const folderMenuItems = (
    folder: StashFolder,
    onOpen: () => void,
    onRename: () => void,
    onDelete: () => void,
  ): MenuItem[] => [
    { label: 'Open', onClick: onOpen },
    { label: 'Rename', onClick: onRename },
    { label: 'Delete', onClick: onDelete, danger: true },
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
        <ContextMenu state={contextMenu} onClose={closeContextMenu} />
      </div>
    )
  }

  if (loading) return <div className="fb-status">Loading…{modals}<ContextMenu state={contextMenu} onClose={closeContextMenu} /></div>
  if (error) return <div className="fb-status fb-error">{error}{modals}<ContextMenu state={contextMenu} onClose={closeContextMenu} /></div>

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
        <ContextMenu state={contextMenu} onClose={closeContextMenu} />
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

      {empty && <div className="fb-status fb-empty">{emptyMessage}</div>}

      {/*
        #file-list-body is always attached to the DOM (Playwright spec asserts toBeAttached).
        In grid mode it is hidden with display:none so it doesn't affect layout.
      */}
      <div
        id="file-list-body"
        className="fb-list"
        role="list"
        aria-label="Files and folders"
        style={viewMode !== 'list' ? { display: 'none' } : undefined}
      >
        {viewMode === 'list' && shownFolders.map((folder) => {
          const onOpen = () => navigateToFolder(folder.id, folder.name)
          const onRename = () => setRenameTarget({ kind: 'folder', folder, name: folder.name })
          const onDelete = () => setPendingDelete({ kind: 'folder', folderId: folder.id, name: folder.name })
          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              customization={getCustomization(folder.id)}
              selected={selectedFolders.has(folder.id)}
              onOpen={onOpen}
              onToggleSelect={() => toggleFolderSelection(folder.id)}
              onCustomize={() => setCustomizeFolder({ id: folder.id, name: folder.name })}
              onRename={onRename}
              onDelete={onDelete}
              onContextMenu={(e) => openContextMenu(e, folderMenuItems(folder, onOpen, onRename, onDelete))}
            />
          )
        })}
        {viewMode === 'list' && shownFiles.map((file) => (
          <FileRow
            key={file.sha256}
            file={file}
            selected={selectedFiles.has(file.sha256)}
            starred={starredFiles.has(file.sha256)}
            onToggleSelect={() => toggleFileSelection(file.sha256)}
            onToggleStar={() => toggleStar(file.sha256)}
            onInfo={() => openInfo(file)}
            menuItems={fileMenuItems(file)}
            onContextMenu={(e) => openContextMenu(e, fileMenuItems(file))}
          />
        ))}
      </div>

      {viewMode === 'grid' && (
        <div className="fb-grid" role="list">
          {shownFolders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              customization={getCustomization(folder.id)}
              onOpen={() => navigateToFolder(folder.id, folder.name)}
              onCustomize={() => setCustomizeFolder({ id: folder.id, name: folder.name })}
              onDelete={() => setPendingDelete({ kind: 'folder', folderId: folder.id, name: folder.name })}
            />
          ))}
          {shownFiles.map((file) => (
            <FileCard key={file.sha256} file={file} onInfo={() => openInfo(file)} />
          ))}
        </div>
      )}

      {modals}
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
    </div>
  )
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

/**
 * Fixed-position context menu (#context-menu).
 *
 * Ported from the legacy showContextMenu(x, y, items) in ui.js:976-1025.
 * Always present in the DOM so Playwright's toBeAttached() assertion passes;
 * carries the `hidden` class when not open (matching the legacy .hidden rule).
 * Dismisses on any click outside the menu via a one-shot document listener,
 * identical to the legacy setTimeout-deferred addEventListener pattern.
 */
function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  useEffect(() => {
    if (!state) return
    // Defer so the contextmenu event that opened the menu doesn't immediately
    // close it — same pattern as the legacy `setTimeout(..., 0)` on line 1020.
    const id = setTimeout(() => {
      document.addEventListener('click', onClose, { once: true })
    }, 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('click', onClose)
    }
  }, [state, onClose])

  const style: React.CSSProperties = state
    ? { left: `${state.x}px`, top: `${state.y}px` }
    : {}

  return (
    <div
      id="context-menu"
      className={`context-menu${state ? '' : ' hidden'}`}
      style={style}
      role="menu"
      aria-hidden={!state}
    >
      {state?.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`context-menu-item${item.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose()
            item.onClick()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function FolderRow({
  folder,
  customization,
  selected,
  onOpen,
  onToggleSelect,
  onCustomize,
  onRename,
  onDelete,
  onContextMenu,
}: {
  folder: StashFolder
  customization: FolderCustomization
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onCustomize: () => void
  onRename: () => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const icon = customization.icon ?? '📁'
  return (
    <div
      className={`fb-row fb-folder ${selected ? 'selected' : ''}`}
      role="listitem"
      onContextMenu={onContextMenu}
    >
      <input
        type="checkbox"
        className="fb-checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${folder.name}`}
      />
      <button type="button" className="fb-name fb-folder-open" onClick={onOpen}>
        <span
          className="fb-icon"
          aria-hidden="true"
          style={customization.color ? { color: customization.color } : undefined}
        >
          {icon}
        </span>
        <span className="fb-name-text">{folder.name}</span>
      </button>
      <span className="fb-size">—</span>
      <span className="fb-date">—</span>
      <RowMenu
        label={`Actions for ${folder.name}`}
        items={[
          { label: 'Customize', onClick: onCustomize },
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
  onContextMenu,
}: {
  file: StashFile
  selected: boolean
  starred: boolean
  onToggleSelect: () => void
  onToggleStar: () => void
  onInfo: () => void
  menuItems: MenuItem[]
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const enc = isEncrypted(file)
  const name = fileDisplayName(file)
  return (
    <div
      className={`fb-row fb-file ${selected ? 'selected' : ''} ${enc ? 'encrypted' : ''}`}
      role="listitem"
      aria-label={`${name}, ${formatFileSize(file.size)}${enc ? ', encrypted' : ''}${starred ? ', starred' : ''}`}
      onContextMenu={onContextMenu}
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

/**
 * Grid card for a folder.  The legacy grid view had a customize + delete
 * button directly on the card; we reproduce that with a ⋮ menu so there is
 * a reachable entry point for customisation without cluttering the card face.
 */
function FolderCard({
  folder,
  customization,
  onOpen,
  onCustomize,
  onDelete,
}: {
  folder: StashFolder
  customization: FolderCustomization
  onOpen: () => void
  onCustomize: () => void
  onDelete: () => void
}) {
  const icon = customization.icon ?? '📁'
  return (
    <div className="fb-card fb-folder" role="listitem">
      <button
        type="button"
        className="fb-card-main"
        onClick={onOpen}
        aria-label={`Open folder ${folder.name}`}
      >
        <span
          className="fb-card-icon"
          aria-hidden="true"
          style={customization.color ? { color: customization.color } : undefined}
        >
          {icon}
        </span>
        <span className="fb-card-name">{folder.name}</span>
      </button>
      <RowMenu
        label={`Actions for ${folder.name}`}
        items={[
          { label: 'Customize', onClick: onCustomize },
          { label: 'Delete', onClick: onDelete, danger: true },
        ]}
      />
    </div>
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
