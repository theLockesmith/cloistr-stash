// Comments modal – ported from the legacy showCommentsModal() / renderComments()
// pipeline in app.js.
//
// Legacy behaviour reproduced here:
//   • Comments stored in localStorage keyed by file sha256 (via lib/comments.ts).
//   • Add a comment with the textarea + "Add Comment" button.
//   • Ctrl+Enter (or Cmd+Enter) submits the comment.
//   • Delete a comment with the × button; window.confirm guards each deletion.
//   • Empty comment list shows "No comments yet" placeholder.
//
// DOM structure intentionally matches the Playwright spec
// (tests/e2e/modals-features.spec.js):
//   #comments-modal     → always attached, class includes "hidden" when closed
//   .modal-header h2    → text "Comments"
//   #comments-modal-close
//   #comments-file-name
//   #comments-list
//   #comment-input      → textarea, placeholder "Add a comment..."
//   #add-comment-btn    → button text "Add Comment"
//
// Storage tradeoff: see lib/comments.ts for the localStorage vs Nostr-native
// decision that an operator should make before production launch.

import { useState, useRef, useCallback } from 'react'
import { addComment, deleteComment, getComments, type FileComment } from '../lib/comments'
import type { StashFile } from '../state/types'

function fileDisplayName(file: StashFile): string {
  return file.name || file.sha256.slice(0, 16) + '...'
}

export function CommentsModal({ file, onClose }: { file: StashFile | null; onClose: () => void }) {
  const isOpen = !!file
  const sha256 = file?.sha256 ?? ''
  const [comments, setComments] = useState<FileComment[]>(() => (file ? getComments(sha256) : []))
  const [inputValue, setInputValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Re-load comments whenever the file changes.
  const prevSha256Ref = useRef<string>('')
  if (file && sha256 !== prevSha256Ref.current) {
    prevSha256Ref.current = sha256
    setComments(getComments(sha256))
    setInputValue('')
  }
  if (!file && prevSha256Ref.current !== '') {
    prevSha256Ref.current = ''
    setComments([])
    setInputValue('')
  }

  const handleAdd = useCallback(() => {
    if (!file || !inputValue.trim()) return
    const updated = addComment(sha256, inputValue)
    setComments(updated)
    setInputValue('')
    textareaRef.current?.focus()
  }, [file, sha256, inputValue])

  const handleDelete = useCallback(
    (commentId: string) => {
      if (!file) return
      if (!window.confirm('Delete this comment?')) return
      const updated = deleteComment(sha256, commentId)
      setComments(updated)
    },
    [file, sha256],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleAdd()
      }
    },
    [handleAdd],
  )

  // The modal is ALWAYS rendered so #comments-modal is always attached to the
  // DOM. Playwright spec checks toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="comments-modal" className={`modal${isOpen ? '' : ' hidden'}`}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Comments</h2>
          <button
            type="button"
            id="comments-modal-close"
            className="modal-close"
            onClick={onClose}
            aria-label="Close comments"
          >
            &times;
          </button>
        </div>

        <div className="modal-body comments-modal-body">
          {file && (
            <div id="comments-file-name" className="comments-file-name">
              {fileDisplayName(file)}
            </div>
          )}

          <div id="comments-list" className="comments-list">
            {comments.length === 0 ? (
              <div className="no-comments">No comments yet</div>
            ) : (
              comments.map((comment) => (
                <div key={comment.id} className="comment-item">
                  <div className="comment-header">
                    <span className="comment-date">{new Date(comment.timestamp).toLocaleString()}</span>
                    <div className="comment-actions">
                      <button
                        type="button"
                        className="comment-action-btn delete"
                        title="Delete comment"
                        onClick={() => handleDelete(comment.id)}
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                  <div className="comment-text">{comment.text}</div>
                </div>
              ))
            )}
          </div>

          <div className="comment-input-area">
            <textarea
              ref={textareaRef}
              id="comment-input"
              className="input"
              placeholder="Add a comment..."
              rows={3}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              type="button"
              id="add-comment-btn"
              className="btn btn-primary"
              onClick={handleAdd}
            >
              Add Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
