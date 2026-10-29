// Upload button (file picker) + floating progress panel. Encryption + upload
// run in the store via the ported upload pipeline. Only shown in my-files.

import { useEffect, useRef } from 'react'
import { useStash } from '../state/useStash'
import { uploadsSettled } from './uploadPanel'

/** How long a panel of finished, all-successful uploads stays up. */
const AUTO_HIDE_MS = 4000

export function UploadButton() {
  const { uploadFiles, view } = useStash()
  const inputRef = useRef<HTMLInputElement>(null)
  if (view !== 'my-files') return null

  return (
    <>
      <button type="button" className="upload-btn" onClick={() => inputRef.current?.click()}>
        ⬆ Upload
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void uploadFiles(Array.from(e.target.files))
          }
          e.target.value = ''
        }}
      />
    </>
  )
}

const LABELS: Record<string, string> = {
  pending: 'Queued',
  encrypting: 'Encrypting',
  hashing: 'Hashing',
  uploading: 'Uploading',
  publishing: 'Publishing',
  success: 'Done',
  duplicate: 'Duplicate',
  error: 'Failed',
}

export function UploadProgress() {
  const { uploadItems, dismissUploads } = useStash()
  const settled = uploadsSettled(uploadItems)

  // All done and nothing failed: hide after a moment. A failure stays up
  // until closed, so it cannot be missed.
  useEffect(() => {
    if (uploadItems.length === 0 || settled !== 'done') return
    const timer = setTimeout(dismissUploads, AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [uploadItems, settled, dismissUploads])

  if (uploadItems.length === 0) return null

  return (
    <div className="upload-progress" role="status" aria-live="polite">
      <div className="upload-progress-title">
        Uploads
        <button type="button" className="upload-progress-close" aria-label="Close uploads" onClick={dismissUploads}>
          &times;
        </button>
      </div>
      <ul className="upload-progress-list">
        {uploadItems.map((item) => (
          <li key={item.id} className={`upload-progress-item status-${item.status}`}>
            <span className="upload-progress-name">{item.name}</span>
            <span className="upload-progress-status">
              {item.status === 'error' || item.status === 'duplicate'
                ? item.error || LABELS[item.status]
                : LABELS[item.status] || item.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
