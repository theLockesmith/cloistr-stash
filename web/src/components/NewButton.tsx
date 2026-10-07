// "New" dropdown button — ported from the legacy #new-btn / #new-dropdown-content flow.
//
// Clicking #new-btn toggles the dropdown. Clicking outside closes it.
// The Folder item calls onNewFolder. Element IDs and data-type attributes match
// the legacy HTML and the Playwright spec (folder-operations.spec.js).
//
// The collaborative-document types (docs/sheets/whiteboard/slides) were removed:
// those apps are leaving production, so Stash no longer offers to create them.

import { useEffect, useRef, useState } from 'react'

interface NewButtonProps {
  onNewFolder: () => void
}

export function NewButton({ onNewFolder }: NewButtonProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close the dropdown when the user clicks outside of it.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const handleNewFolder = () => {
    setOpen(false)
    onNewFolder()
  }

  return (
    <div className="new-dropdown" ref={containerRef}>
      <button
        id="new-btn"
        type="button"
        className="btn btn-accent"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="icon">+</span> New <span className="dropdown-arrow">▾</span>
      </button>
      <div
        id="new-dropdown-content"
        className={`new-dropdown-content${open ? ' show' : ''}`}
      >
        <button
          type="button"
          className="dropdown-item"
          data-type="folder"
          onClick={handleNewFolder}
        >
          <span className="dropdown-icon">📁</span> Folder
        </button>
      </div>
    </div>
  )
}
