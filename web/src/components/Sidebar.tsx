// Sidebar: special-view navigation + folder tree (ported from app.js
// renderFolderTree / view switching). Folder tree is built from folderTreeData
// by parent_id, with expand/collapse; clicking navigates by absolute path.

import { useMemo, useState } from 'react'
import { useStash } from '../state/useStash'
import type { StashFolder, StashView } from '../state/types'

const VIEWS: { id: StashView; label: string; icon: string }[] = [
  { id: 'my-files', label: 'My Files', icon: '📁' },
  { id: 'shared', label: 'Shared', icon: '🔗' },
  { id: 'starred', label: 'Starred', icon: '★' },
  { id: 'recent', label: 'Recent', icon: '🕘' },
  { id: 'trash', label: 'Trash', icon: '🗑️' },
]

interface SidebarProps {
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
}

export function Sidebar({ isOpen, onToggle }: SidebarProps) {
  const {
    view,
    setView,
    folderTreeData,
    currentFolderId,
    navigateToFolderAbsolute,
    navigateToRoot,
  } = useStash()

  // "My Stash" root row is highlighted only at the top of the my-files view.
  const isAtRoot = currentFolderId === '' && view === 'my-files'

  // Group folders by parent for tree rendering.
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

  return (
    <aside id="sidebar" className="sidebar" role="navigation" aria-label="File navigation">
      {/* Sidebar header with title and desktop collapse toggle (matches legacy #sidebar-toggle) */}
      <div className="sidebar-header">
        <span id="sidebar-title" className="sidebar-title">Folders</span>
        <button
          id="sidebar-toggle"
          type="button"
          className="btn btn-icon sidebar-toggle"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          aria-expanded={true}
          onClick={onToggle}
        >
          ☰
        </button>
      </div>

      <nav className="sidebar-views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`sidebar-view ${view === v.id ? 'active' : ''}`}
            aria-current={view === v.id}
            onClick={() => void setView(v.id)}
          >
            <span aria-hidden="true">{v.icon}</span> {v.label}
          </button>
        ))}
      </nav>

      {/* Tree container is unconditional: the "My Stash" root row must be
          reachable even before any folder exists, so a new user can navigate
          back to the root after creating their first folder. */}
      <div id="folder-tree" className="sidebar-tree" role="tree" aria-label="Folders">
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

        {folderTreeData.length > 0 && (
          <div id="folder-tree-root" role="group">
            <FolderTree
              parentId=""
              childrenByParent={childrenByParent}
              currentFolderId={currentFolderId}
              onNavigate={(id) => void navigateToFolderAbsolute(id)}
            />
          </div>
        )}
      </div>
    </aside>
  )
}

function FolderTree({
  parentId,
  childrenByParent,
  currentFolderId,
  onNavigate,
}: {
  parentId: string
  childrenByParent: Map<string, StashFolder[]>
  currentFolderId: string
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
  onNavigate,
}: {
  folder: StashFolder
  childrenByParent: Map<string, StashFolder[]>
  currentFolderId: string
  onNavigate: (id: string) => void
}) {
  const hasChildren = (childrenByParent.get(folder.id)?.length ?? 0) > 0
  const [expanded, setExpanded] = useState(false)

  return (
    <li className="folder-tree-node" role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div className={`folder-tree-row ${currentFolderId === folder.id ? 'active' : ''}`}>
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
        <button type="button" className="folder-tree-name" onClick={() => onNavigate(folder.id)}>
          📁 {folder.name}
        </button>
      </div>
      {hasChildren && expanded && (
        <FolderTree
          parentId={folder.id}
          childrenByParent={childrenByParent}
          currentFolderId={currentFolderId}
          onNavigate={onNavigate}
        />
      )}
    </li>
  )
}
