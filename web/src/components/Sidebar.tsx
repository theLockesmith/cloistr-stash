// Sidebar: folder tree + quick-access navigation (ported from app.js renderFolderTree
// and legacy sidebar HTML). Element IDs, roles, and aria attributes match the
// Playwright spec (folder-operations.spec.js).

import { useMemo, useState } from 'react'
import { useStash } from '../state/useStash'
import type { StashFolder } from '../state/types'

export function Sidebar() {
  const {
    view,
    setView,
    folderTreeData,
    currentFolderId,
    navigateToFolderAbsolute,
    navigateToRoot,
  } = useStash()

  const [sidebarExpanded, setSidebarExpanded] = useState(true)

  const childrenByParent = useMemo(() => {
    const map = new Map<string, StashFolder[]>()
    for (const f of folderTreeData) {
      const parent = f.parent_id || ''
      const arr = map.get(parent) ?? []
      arr.push(f)
      map.set(parent, arr)
    }
    return map
  }, [folderTreeData])

  const isAtRoot = currentFolderId === '' && view === 'my-files'

  return (
    <aside
      id="sidebar"
      className="sidebar"
      role="navigation"
      aria-label="File navigation"
    >
      {/* Header: tree title + collapse toggle */}
      <div className="sidebar-header">
        <span id="sidebar-title" className="sidebar-tree-title">Folders</span>
        <button
          id="sidebar-toggle"
          type="button"
          className="sidebar-tree-toggle"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          aria-expanded={sidebarExpanded}
          onClick={() => setSidebarExpanded((x) => !x)}
        >
          {sidebarExpanded ? '◀' : '▶'}
        </button>
      </div>

      {/* Folder tree */}
      <div
        id="folder-tree"
        className="sidebar-tree"
        role="tree"
        aria-labelledby="sidebar-title"
      >
        {/* Root item — "My Stash" always visible */}
        <div
          className={`folder-tree-item root${isAtRoot ? ' active' : ''}`}
          role="treeitem"
          tabIndex={0}
          aria-selected={isAtRoot}
          onClick={() => void navigateToRoot()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') void navigateToRoot()
          }}
        >
          <span className="folder-tree-icon" aria-hidden="true">🏠</span>
          <span className="folder-tree-name">My Stash</span>
        </div>

        {/* Root-level folder children */}
        <div id="folder-tree-root" role="group">
          <FolderTree
            parentId=""
            childrenByParent={childrenByParent}
            currentFolderId={currentFolderId}
            activeView={view}
            onNavigate={(id) => void navigateToFolderAbsolute(id)}
          />
        </div>
      </div>

      {/* Quick-access navigation */}
      <nav className="sidebar-section" role="navigation" aria-label="Quick access">
        {([
          { id: 'nav-starred', viewId: 'starred', icon: '★', label: 'Starred' },
          { id: 'nav-recent',  viewId: 'recent',  icon: '🕘', label: 'Recent' },
          { id: 'nav-trash',   viewId: 'trash',   icon: '🗑️', label: 'Trash' },
        ] as const).map((item) => (
          <div
            key={item.id}
            id={item.id}
            className="sidebar-nav-item"
            role="button"
            tabIndex={0}
            aria-current={view === item.viewId}
            onClick={() => void setView(item.viewId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') void setView(item.viewId)
            }}
          >
            <span aria-hidden="true">{item.icon}</span> {item.label}
          </div>
        ))}
        {/* Stub items for future features — required by spec */}
        <div
          id="nav-activity"
          className="sidebar-nav-item"
          role="button"
          tabIndex={0}
        >
          <span aria-hidden="true">📊</span> Activity
        </div>
        <div
          id="nav-notifications"
          className="sidebar-nav-item"
          role="button"
          tabIndex={0}
        >
          <span aria-hidden="true">🔔</span> Notifications
        </div>
      </nav>

      {/* Storage usage summary */}
      <div id="storage-usage" className="sidebar-storage">
        <div className="storage-info">
          <span>Storage</span>
          <span id="storage-value">— used</span>
        </div>
        <div className="storage-bar">
          <div
            id="storage-bar-fill"
            className="storage-bar-fill"
            style={{ width: '0%' }}
          />
        </div>
      </div>
    </aside>
  )
}

// ── Recursive folder tree ────────────────────────────────────────────────────

function FolderTree({
  parentId,
  childrenByParent,
  currentFolderId,
  activeView,
  onNavigate,
}: {
  parentId: string
  childrenByParent: Map<string, StashFolder[]>
  currentFolderId: string
  activeView: string
  onNavigate: (id: string) => void
}) {
  const children = childrenByParent.get(parentId) ?? []
  if (children.length === 0) return null
  return (
    <ul className="folder-tree-list">
      {children.map((folder) => (
        <FolderTreeNode
          key={folder.id}
          folder={folder}
          childrenByParent={childrenByParent}
          currentFolderId={currentFolderId}
          activeView={activeView}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  )
}

function FolderTreeNode({
  folder,
  childrenByParent,
  currentFolderId,
  activeView,
  onNavigate,
}: {
  folder: StashFolder
  childrenByParent: Map<string, StashFolder[]>
  currentFolderId: string
  activeView: string
  onNavigate: (id: string) => void
}) {
  const hasChildren = (childrenByParent.get(folder.id)?.length ?? 0) > 0
  const [expanded, setExpanded] = useState(false)
  const isActive = currentFolderId === folder.id && activeView === 'my-files'

  return (
    <li
      className={`folder-tree-node${isActive ? ' active' : ''}`}
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
    >
      <div className="folder-tree-row">
        {hasChildren ? (
          <button
            type="button"
            className="folder-tree-toggle"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="folder-tree-toggle-spacer" />
        )}
        <button
          type="button"
          className="folder-tree-name"
          onClick={() => onNavigate(folder.id)}
        >
          📁 {folder.name}
        </button>
      </div>
      {hasChildren && expanded && (
        <FolderTree
          parentId={folder.id}
          childrenByParent={childrenByParent}
          currentFolderId={currentFolderId}
          activeView={activeView}
          onNavigate={onNavigate}
        />
      )}
    </li>
  )
}
