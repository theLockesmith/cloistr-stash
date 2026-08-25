// Sidebar nav content — rendered by AppShell as the `nav` prop.
//
// AppShell owns the off-canvas drawer on mobile and the in-flow aside on
// desktop. This component renders the nav content only (views, folder tree,
// bottom actions) without re-deriving the drawer shell.
//
// `collapsed` / `onToggle` are desktop-only: on mobile AppShell's drawer is
// either fully open or fully closed, so these props are irrelevant there.
//
// The legacy ids and classes (#sidebar-toggle, #folder-tree, #nav-notifications,
// #nav-activity) are preserved so E2E specs pass unchanged.

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
  /**
   * DESKTOP icons-only state — a persisted user preference. Not relevant on
   * mobile because AppShell's drawer is all-or-nothing.
   */
  collapsed?: boolean
  onToggle: () => void
  onOpenNotifications: () => void
  onOpenActivity: () => void
}

export function Sidebar({ collapsed = false, onToggle, onOpenNotifications, onOpenActivity }: SidebarProps) {
  const {
    view,
    setView,
    folderTreeData,
    currentFolderId,
    navigateToFolderAbsolute,
    navigateToRoot,
    unreadNotificationCount,
    quota,
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
    <div id="sidebar" className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="File navigation">
      {/* Sidebar header with title and desktop collapse toggle */}
      <div className="sidebar-header">
        <span id="sidebar-title" className="sidebar-title">Folders</span>
        <button
          id="sidebar-toggle"
          type="button"
          className="btn btn-icon sidebar-toggle"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          aria-expanded={!collapsed}
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

      {/* Secondary nav items (mirrors legacy sidebar-nav-item structure for E2E compat).
          Notifications and Activity share one <nav>: the two ports each added their
          own container, and keeping both would give the sidebar two sibling nav
          landmarks with the same role. */}
      <nav className="sidebar-nav-extra" aria-label="Actions">
        {/* Notifications nav item — matches legacy #nav-notifications */}
        <div
          id="nav-notifications"
          className="sidebar-nav-item"
          title="Share notifications"
          role="button"
          tabIndex={0}
          aria-label="Notifications"
          onClick={onOpenNotifications}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpenNotifications()
            }
          }}
        >
          <span className="sidebar-nav-icon" aria-hidden="true">🔔</span>
          <span className="sidebar-nav-name">Notifications</span>
          <span
            className="sidebar-nav-badge notification-badge"
            id="notification-count"
            aria-live="polite"
          >
            {unreadNotificationCount > 0
              ? unreadNotificationCount > 99
                ? '99+'
                : unreadNotificationCount
              : ''}
          </span>
        </div>
        {/* Activity log nav item — matches legacy #nav-activity */}
        <div
          id="nav-activity"
          className="sidebar-nav-item"
          title="Activity log"
          role="button"
          tabIndex={0}
          aria-label="Activity"
          onClick={onOpenActivity}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpenActivity()
            }
          }}
        >
          <span className="sidebar-nav-icon" aria-hidden="true">📋</span>
          <span className="sidebar-nav-name">Activity</span>
        </div>
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

      {/* Storage quota bar — mirrors legacy #storage-value / #storage-bar-fill / #storage-details.
          Only rendered when the server returns an enabled quota. */}
      {quota?.enabled && (
        <div id="storage-quota" className="sidebar-quota">
          <div
            id="storage-bar"
            className="quota-bar"
            role="progressbar"
            aria-valuenow={quota.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Storage used"
          >
            <div
              id="storage-bar-fill"
              className={`quota-bar-fill${quota.percent > 90 ? ' quota-danger' : quota.percent > 70 ? ' quota-warn' : ''}`}
              style={{ width: `${quota.percent}%` }}
            />
          </div>
          <p id="storage-details" className="quota-details">
            {quota.unlimited ? 'Unlimited storage' : `${quota.usedHuman} of ${quota.limitHuman} used`}
          </p>
        </div>
      )}
    </div>
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
