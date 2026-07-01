// Breadcrumb navigation for the current folder path (ported from app.js
// renderBreadcrumbs). Clicking an ancestor navigates to it (absolute path).

import { useStash } from '../state/useStash'

export function Breadcrumbs() {
  const { folderPath, view, navigateToRoot, navigateToFolderAbsolute } = useStash()

  if (view !== 'my-files') {
    const label =
      view === 'starred' ? 'Starred' : view === 'recent' ? 'Recent' : view === 'trash' ? 'Trash' : 'Shared'
    return (
      <nav className="breadcrumbs" aria-label="Location">
        <span className="breadcrumb-current">{label}</span>
      </nav>
    )
  }

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <button type="button" className="breadcrumb-item" onClick={() => void navigateToRoot()}>
        My Stash
      </button>
      {folderPath.map((item) => (
        <span key={item.id} className="breadcrumb-segment">
          <span className="breadcrumb-sep" aria-hidden="true">
            /
          </span>
          <button
            type="button"
            className="breadcrumb-item"
            onClick={() => void navigateToFolderAbsolute(item.id)}
          >
            {item.name}
          </button>
        </span>
      ))}
    </nav>
  )
}
