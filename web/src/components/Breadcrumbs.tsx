// Breadcrumb navigation for the current folder path (ported from app.js
// renderBreadcrumbs). Element IDs and data-id attributes match the Playwright
// spec (folder-operations.spec.js). Clicking an ancestor navigates to it.

import { useStash } from '../state/useStash'

export function Breadcrumbs() {
  const { folderPath, view, navigateToRoot, navigateToFolderAbsolute } = useStash()

  // Non-file views show a single label (no path navigation).
  if (view !== 'my-files') {
    const label =
      view === 'starred'
        ? 'Starred'
        : view === 'recent'
          ? 'Recent'
          : view === 'trash'
            ? 'Trash'
            : 'Shared'
    return (
      <div id="breadcrumb-bar">
        <nav id="breadcrumb" className="breadcrumbs" aria-label="Location">
          <span className="breadcrumb-current">{label}</span>
        </nav>
      </div>
    )
  }

  const atRoot = folderPath.length === 0

  return (
    <div id="breadcrumb-bar">
      <nav id="breadcrumb" className="breadcrumbs" aria-label="Breadcrumb">
        {/* Root item — always present; active when no sub-folder selected */}
        <button
          type="button"
          className={`breadcrumb-item${atRoot ? ' active' : ''}`}
          data-id=""
          onClick={() => void navigateToRoot()}
        >
          My Stash
        </button>

        {folderPath.map((item, idx) => {
          const isLast = idx === folderPath.length - 1
          return (
            <span key={item.id} className="breadcrumb-segment">
              <span className="breadcrumb-sep" aria-hidden="true">/</span>
              <button
                type="button"
                className={`breadcrumb-item${isLast ? ' active' : ''}`}
                data-id={item.id}
                onClick={() => void navigateToFolderAbsolute(item.id)}
              >
                {item.name}
              </button>
            </span>
          )
        })}
      </nav>
    </div>
  )
}
