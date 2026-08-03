// "New" dropdown button — ported from the legacy #new-btn / #new-dropdown-content flow.
//
// Clicking #new-btn toggles the dropdown. Clicking outside closes it.
// The Folder item calls onNewFolder; collaborative-doc items open the app in a new tab.
// Element IDs, data-type attributes, and dropdown-icon content match the legacy HTML
// and the Playwright spec (folder-operations.spec.js).

import { useEffect, useRef, useState } from 'react'

const COLLAB_APPS: { type: string; icon: string; label: string; url: string }[] = [
  { type: 'doc', icon: '📄', label: 'Document', url: 'https://docs.cloistr.xyz' },
  { type: 'sheet', icon: '📊', label: 'Spreadsheet', url: 'https://sheets.cloistr.xyz' },
  { type: 'whiteboard', icon: '🎨', label: 'Whiteboard', url: 'https://whiteboard.cloistr.xyz' },
  { type: 'slides', icon: '📽️', label: 'Presentation', url: 'https://slides.cloistr.xyz' },
]

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

  const handleCollabApp = (url: string) => {
    setOpen(false)
    const docId = `doc-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    window.open(`${url}?docId=${docId}`, '_blank')
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
        <div className="dropdown-divider" />
        {COLLAB_APPS.map((app) => (
          <button
            key={app.type}
            type="button"
            className="dropdown-item"
            data-type={app.type}
            onClick={() => handleCollabApp(app.url)}
          >
            <span className="dropdown-icon">{app.icon}</span> {app.label}
          </button>
        ))}
      </div>
    </div>
  )
}
