// File info modal – ported from legacy showFileInfo() in app.js.
//
// Legacy behaviour reproduced here:
//   • showFileInfo() populated five metadata fields: name, size, MIME type,
//     created_at timestamp, encrypted flag, truncated sha256 hash.
//   • Modal footer had six action buttons: Preview, Download, Share, Public
//     Link, Version History, Delete. Public Link IS now ported (see the
//     "Public link" row below): the operator asked how to retrieve a published
//     file's link without re-running the whole "Share publicly" flow, and the
//     answer was that you could not.
//   • Clicking any filename text in the file list opened the info modal.
//
// DOM structure intentionally matches the Playwright spec
// (tests/e2e/modals-features.spec.js:404):
//   #file-info-modal  →  always attached, class includes "hidden" when closed
//   .modal-header h2  →  text "File Info"
//
// The download action fetches and decrypts (when needed) the blob and triggers
// a browser anchor-click download – the same pipeline as the legacy downloadFile().

import { useEffect, useState } from 'react'
import type { StashFile } from '../state/types'
import { formatFileSize } from './format'
import { API } from '../lib/api'
import { Keys } from '../lib/keys'
import { Crypto } from '../lib/crypto'
import { publicUrlForFile, checkPublished, type PublicState } from '../lib/publish'

// ─── download helper ─────────────────────────────────────────────────────────

async function triggerDownload(file: StashFile): Promise<void> {
  const downloadUrl = API.getDownloadURL(file.sha256)
  const response = await fetch(downloadUrl)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)

  const encryptedData = await response.arrayBuffer()
  let data: Uint8Array

  const enc = !!(file.encrypted || (file as Record<string, unknown>).encryption)
  if (enc) {
    const fileId = (
      file.id ??
      (file as Record<string, unknown>).file_id ??
      (file as Record<string, unknown>).fileId ??
      (file as Record<string, unknown>).d
    ) as string | undefined
    const folderId = (
      (file as Record<string, unknown>).folder_id ??
      (file as Record<string, unknown>).folderId ??
      file.folder
    ) as string | undefined
    if (!fileId) throw new Error('Cannot decrypt: missing file ID')
    const fileKey = folderId
      ? await Keys.deriveFileKey(folderId, fileId)
      : await Keys.deriveRootFileKey(fileId)
    data = await Crypto.decryptFile(encryptedData, fileKey)
    Crypto.wipeKey(fileKey)
  } else {
    data = new Uint8Array(encryptedData)
  }

  const mimeType = (file.mime_type as string | undefined) ?? 'application/octet-stream'
  const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType })
  const blobUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = file.name ?? file.sha256
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
}

// ─── component ───────────────────────────────────────────────────────────────

export interface FileInfoModalProps {
  file: StashFile | null
  onClose: () => void
  onPreview: (file: StashFile) => void
  onShare: (file: StashFile) => void
  onVersions: (file: StashFile) => void
  onDelete: (file: StashFile) => void
}

export function FileInfoModal({ file, onClose, onPreview, onShare, onVersions, onDelete }: FileInfoModalProps) {
  const [downloading, setDownloading] = useState(false)

  const isOpen = !!file

  const hash = file?.sha256 ?? '-'
  const hashShort = hash.length > 24 ? `${hash.slice(0, 16)}...${hash.slice(-8)}` : hash
  const created = file?.created_at
    ? new Date((file.created_at as number) * 1000).toLocaleString()
    : 'Unknown'
  const isEncrypted = file ? file.encrypted !== false : false
  const type = (file?.mime_type ?? (file?.mimeType as string | undefined) ?? 'Unknown') as string

  async function handleDownload() {
    if (!file || downloading) return
    setDownloading(true)
    try {
      await triggerDownload(file)
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setDownloading(false)
    }
  }

  // Public link. The URL is DERIVED from the stored plaintext hash rather than
  // stored separately, and whether it is currently served is asked of the
  // server rather than cached — a stale "published" flag would hand the user a
  // link that 404s, which is worse than showing nothing.
  const publicUrl = file ? publicUrlForFile(file) : null
  const [publicState, setPublicState] = useState<PublicState>('unknown')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isOpen || !publicUrl) return
    let cancelled = false
    setPublicState('unknown')
    void checkPublished(publicUrl).then((s) => {
      if (!cancelled) setPublicState(s)
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, publicUrl])

  // The modal is ALWAYS rendered so #file-info-modal is always attached to the
  // DOM. Playwright spec checks toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="file-info-modal" className={`modal${isOpen ? '' : ' hidden'}`}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>File Info</h2>
          <button
            type="button"
            className="modal-close"
            id="file-info-modal-close"
            onClick={onClose}
            aria-label="Close file info"
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <dl className="file-info">
            <dt>Name</dt>
            <dd>{file?.name ?? '—'}</dd>
            <dt>Size</dt>
            <dd>{file?.size !== undefined ? formatFileSize(file.size) : '—'}</dd>
            <dt>Type</dt>
            <dd>{type}</dd>
            <dt>Created</dt>
            <dd>{created}</dd>
            <dt>Encrypted</dt>
            <dd>{isEncrypted ? 'Yes (E2E)' : 'No'}</dd>
            <dt>Hash</dt>
            <dd title={hash}>
              <code>{hashShort}</code>
            </dd>
            {publicUrl && (
              <>
                <dt>Public link</dt>
                <dd>
                  {publicState === 'published' ? (
                    <span className="file-info-public">
                      <code
                        className="file-info-public-url"
                        id="file-info-public-url"
                        title={publicUrl}
                      >
                        {publicUrl}
                      </code>
                      <button
                        type="button"
                        className="selection-btn"
                        id="file-info-copy-public"
                        onClick={() => {
                          void navigator.clipboard.writeText(publicUrl).then(() => {
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                          })
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </span>
                  ) : publicState === 'not-published' ? (
                    <span className="file-info-muted">Not shared publicly</span>
                  ) : (
                    // NOT "not published": we could not ask. Saying otherwise
                    // would tell the user a public file is private.
                    <span className="file-info-muted">Checking…</span>
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>

        <div className="modal-footer file-info-actions">
          <button
            type="button"
            className="selection-btn"
            id="file-info-preview"
            title="Preview file"
            disabled={!file}
            onClick={() => {
              if (file) { onClose(); onPreview(file) }
            }}
          >
            Preview
          </button>
          <button
            type="button"
            className="selection-btn"
            id="file-info-download"
            title="Download file"
            disabled={!file || downloading}
            onClick={() => void handleDownload()}
          >
            {downloading ? 'Downloading...' : 'Download'}
          </button>
          <button
            type="button"
            className="selection-btn"
            id="file-info-share"
            title="Share with others"
            disabled={!file}
            onClick={() => {
              if (file) { onClose(); onShare(file) }
            }}
          >
            Share
          </button>
          <button
            type="button"
            className="selection-btn"
            id="file-info-history"
            title="Version history"
            disabled={!file}
            onClick={() => {
              if (file) { onClose(); onVersions(file) }
            }}
          >
            History
          </button>
          <button
            type="button"
            className="selection-btn danger"
            id="file-info-delete"
            title="Delete file"
            disabled={!file}
            onClick={() => {
              if (file) { onClose(); onDelete(file) }
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
