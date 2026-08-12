// In-app file editor modal (ported from legacy #editor-modal).
//
// Behaviour match: modal is always present in the DOM and carries class
// "hidden" when closed -- required by tests/e2e/modals-features.spec.js:
//
//   const modal = page.locator('#editor-modal');
//   expect(modal).toBeAttached();
//   expect(modal).toHaveClass(/hidden/);
//   expect(modal.locator('.modal-header h2')).toHaveText('Edit File');
//
// NOT using @cloistr/ui Modal because that component removes itself from the
// DOM when closed (returns null) and uses cloistr-modal-* class names, so it
// would break the always-attached / .modal-header / .hidden expectations.
//
// Intentionally left out:
//   - Multi-user WebRTC signaling: setupNostrSignaling is a stub in
//     collaboration.ts; real-time sync requires that stub to be wired.
//   - Collaborator chips: y-protocols is not installed (collaboration.ts:10-13),
//     so sessions always run in soloMode — awareness / cursor / presence are
//     unavailable and the chip strip is rendered empty.
//
// The save path DOES work when Collaboration.configure() has been called in
// App.tsx (which injects downloadFileData / createVersion / shareFile deps).

import { useEffect, useRef, useState } from 'react'
import { Collaboration, type CollabSession } from '../lib/collaboration'
import type { StashFile } from '../state/types'

type EditorStatus = 'Ready' | 'Loading...' | 'Saving...' | 'Saved' | string

interface EditorModalProps {
  file: StashFile | null
  onClose: () => void
}

export function EditorModal({ file, onClose }: EditorModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [session, setSession] = useState<CollabSession | null>(null)
  const [status, setStatus] = useState<EditorStatus>('Ready')

  // Start / end collaboration session when the target file changes.
  useEffect(() => {
    if (!file) {
      setSession(null)
      return
    }

    let cancelled = false
    setStatus('Loading...')
    setSession(null)

    void Collaboration.startSession(file, {
      onSync: () => {
        if (!cancelled) setStatus('Ready')
      },
    })
      .then((s) => {
        if (cancelled) {
          void Collaboration.endSession(s.fileId)
          return
        }
        setSession(s)
        setStatus('Ready')
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus(`Error: ${err?.message ?? 'Unknown'}`)
      })

    return () => {
      cancelled = true
      // Resolve fileId the same way collaboration.ts does it.
      const f = file as Record<string, unknown>
      const fileId =
        (f.file_id as string | undefined) ??
        (f.fileId as string | undefined) ??
        (f.d as string | undefined) ??
        file.id ??
        file.sha256
      if (fileId) void Collaboration.endSession(fileId)
      setSession(null)
    }
  }, [file])

  // Keep the textarea in sync with the Yjs document.
  // The observer fires whenever any peer (including our own transact calls)
  // applies an update to the Y.Text.
  useEffect(() => {
    if (!session) return

    const yText = session.yDoc.getText('content')

    // Set initial textarea value once the session and content are ready.
    if (textareaRef.current) {
      textareaRef.current.value = yText.toString()
    }

    const observer = () => {
      const el = textareaRef.current
      if (!el) return
      const newContent = yText.toString()
      if (el.value === newContent) return
      // Preserve cursor position across remote updates.
      const selStart = el.selectionStart
      const selEnd = el.selectionEnd
      el.value = newContent
      el.selectionStart = Math.min(selStart, newContent.length)
      el.selectionEnd = Math.min(selEnd, newContent.length)
    }

    yText.observe(observer)
    return () => {
      try {
        yText.unobserve(observer)
      } catch {
        // yDoc may already be destroyed if endSession ran first.
      }
    }
  }, [session])

  // Propagate textarea edits into the Yjs document (full-replace, mirrors legacy).
  const handleTextareaInput = () => {
    if (!session || !textareaRef.current) return
    const yText = session.yDoc.getText('content')
    const newValue = textareaRef.current.value
    if (yText.toString() === newValue) return
    session.yDoc.transact(() => {
      yText.delete(0, yText.length)
      yText.insert(0, newValue)
    })
  }

  const handleSave = () => {
    if (!session) return
    setStatus('Saving...')
    void Collaboration.saveDocument(session)
      .then(() => setStatus('Saved'))
      .catch(() => setStatus('Save failed'))
  }

  const handleSaveClose = () => {
    if (!session) {
      onClose()
      return
    }
    setStatus('Saving...')
    void Collaboration.saveDocument(session)
      .then(() => {
        setStatus('Saved')
        onClose()
      })
      .catch(() => setStatus('Save failed'))
  }

  const handleInvite = () => {
    if (!session) return
    const npub = window.prompt('Enter collaborator npub:')
    if (!npub) return
    void Collaboration.inviteCollaborator(session.fileId, npub).catch((err: Error) => {
      console.error('Invite failed:', err)
    })
  }

  const isOpen = !!file
  // Default h2 text "Edit File" is required by the Playwright spec which checks
  // .modal-header h2 against the always-attached, hidden-by-default modal.
  const heading = file?.name ? `Edit: ${file.name}` : 'Edit File'

  return (
    <div
      id="editor-modal"
      className={`modal${isOpen ? '' : ' hidden'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Edit File"
    >
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h2>{heading}</h2>
          <div className="editor-toolbar">
            {/* Collaborator chips: always empty in soloMode (y-protocols not installed) */}
            <div
              id="editor-collaborators"
              className="editor-collaborators"
              aria-label="Active collaborators"
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={handleInvite}
              disabled={!isOpen}
              aria-label="Invite collaborator"
            >
              Invite
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={handleSave}
              disabled={!isOpen}
            >
              Save
            </button>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close editor"
          >
            &times;
          </button>
        </div>
        <div className="modal-body editor-body">
          <textarea
            ref={textareaRef}
            id="editor-textarea"
            className="editor-textarea"
            placeholder="Loading..."
            onInput={handleTextareaInput}
            disabled={!isOpen}
            aria-label="File content"
          />
        </div>
        <div className="modal-footer">
          <span id="editor-status" className="editor-status">
            {isOpen ? status : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveClose}
            disabled={!isOpen}
          >
            Save &amp; Close
          </button>
        </div>
      </div>
    </div>
  )
}