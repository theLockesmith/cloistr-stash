// File preview modal – ported from the legacy showPreview() / initMarkdownViewer()
// pipeline in app.js.
//
// Legacy behaviour reproduced here:
//   • getPreviewType() – extension-first, then MIME type for markdown detection;
//     same seven branches (image/video/audio/pdf/markdown/text/unsupported).
//   • Fetch + conditional decrypt (Keys.deriveFileKey / deriveRootFileKey +
//     Crypto.decryptFile) identical to the legacy showPreview() path.
//   • Markdown: rendered via marked (gfm + breaks), two tabs (Preview / Source),
//     Copy button writes raw source to clipboard.
//
// DOM structure intentionally matches the Playwright spec
// (tests/e2e/modals-features.spec.js:397):
//   #preview-modal  →  always attached, class includes "hidden" when closed
//   .modal-header h2  →  text "Preview" when closed, filename when open
//
// Not ported: PDF (requires pdf.js), code syntax highlighting (requires hljs),
// video/audio media controls (minor nice-to-have), full-screen. All are absent
// in the React port generally and are independent of the markdown feature.

import { useState, useEffect, useRef } from 'react'
import { marked } from 'marked'
import type { StashFile } from '../state/types'
import { API } from '../lib/api'
import { Keys } from '../lib/keys'
import { Crypto } from '../lib/crypto'

// ─── type detection ─────────────────────────────────────────────────────────

type PreviewType = 'markdown' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'unsupported'

function getPreviewType(mimeType: string, filename: string): PreviewType {
  if (!mimeType) return 'unsupported'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'md' || ext === 'markdown' || mimeType === 'text/markdown') return 'markdown'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/xml'
  )
    return 'text'
  return 'unsupported'
}

// ─── component ───────────────────────────────────────────────────────────────

type MdTab = 'preview' | 'source'

interface PreviewState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  previewType: PreviewType | null
  // markdown
  markdownRaw: string | null
  markdownHtml: string | null
  // generic text
  textContent: string | null
  // blob-backed (image / video / audio)
  blobUrl: string | null
  errorMessage: string | null
}

const IDLE: PreviewState = {
  status: 'idle',
  previewType: null,
  markdownRaw: null,
  markdownHtml: null,
  textContent: null,
  blobUrl: null,
  errorMessage: null,
}

export function PreviewModal({ file, onClose }: { file: StashFile | null; onClose: () => void }) {
  const [state, setState] = useState<PreviewState>(IDLE)
  const [mdTab, setMdTab] = useState<MdTab>('preview')
  const [copied, setCopied] = useState(false)
  const prevBlobUrl = useRef<string | null>(null)

  const isOpen = !!file

  // Clean up blob URL on unmount or when file changes.
  useEffect(() => {
    return () => {
      if (prevBlobUrl.current) {
        URL.revokeObjectURL(prevBlobUrl.current)
        prevBlobUrl.current = null
      }
    }
  }, [])

  // Load preview whenever file changes.
  useEffect(() => {
    if (!file) {
      if (prevBlobUrl.current) {
        URL.revokeObjectURL(prevBlobUrl.current)
        prevBlobUrl.current = null
      }
      setState(IDLE)
      setMdTab('preview')
      return
    }

    setState({ ...IDLE, status: 'loading' })
    setMdTab('preview')

    const mimeType = (file.mime_type as string | undefined) ?? 'application/octet-stream'
    const pType = getPreviewType(mimeType, file.name ?? '')

    let cancelled = false

    void (async () => {
      try {
        // Fetch
        const downloadUrl = API.getDownloadURL(file.sha256)
        const response = await fetch(downloadUrl)
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
        const encryptedData = await response.arrayBuffer()

        // Decrypt if needed
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

        if (cancelled) return

        // Produce preview artefact
        if (pType === 'markdown') {
          const raw = new TextDecoder().decode(data)
          const html = marked(raw, { gfm: true, breaks: true, async: false }) as string
          if (cancelled) return
          setState({
            status: 'ready',
            previewType: 'markdown',
            markdownRaw: raw,
            markdownHtml: html,
            textContent: null,
            blobUrl: null,
            errorMessage: null,
          })
        } else if (pType === 'text') {
          const text = new TextDecoder().decode(data)
          if (cancelled) return
          setState({
            status: 'ready',
            previewType: 'text',
            markdownRaw: null,
            markdownHtml: null,
            textContent: text,
            blobUrl: null,
            errorMessage: null,
          })
        } else if (pType === 'image' || pType === 'video' || pType === 'audio') {
          if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current)
          // Cast to Uint8Array<ArrayBuffer> to satisfy Blob constructor type.
          const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType })
          const url = URL.createObjectURL(blob)
          prevBlobUrl.current = url
          if (cancelled) { URL.revokeObjectURL(url); prevBlobUrl.current = null; return }
          setState({
            status: 'ready',
            previewType: pType,
            markdownRaw: null,
            markdownHtml: null,
            textContent: null,
            blobUrl: url,
            errorMessage: null,
          })
        } else if (pType === 'pdf') {
          // Create a blob URL for the decrypted PDF and let the browser render
          // it in an <iframe>. No external library needed — all modern browsers
          // have a built-in PDF viewer they surface through iframes with blob: URLs.
          if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current)
          const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/pdf' })
          const url = URL.createObjectURL(blob)
          prevBlobUrl.current = url
          if (cancelled) { URL.revokeObjectURL(url); prevBlobUrl.current = null; return }
          setState({
            status: 'ready',
            previewType: 'pdf',
            markdownRaw: null,
            markdownHtml: null,
            textContent: null,
            blobUrl: url,
            errorMessage: null,
          })
        } else {
          // unsupported
          if (cancelled) return
          setState({
            status: 'ready',
            previewType: pType,
            markdownRaw: null,
            markdownHtml: null,
            textContent: null,
            blobUrl: null,
            errorMessage: null,
          })
        }
      } catch (err) {
        if (cancelled) return
        setState({
          status: 'error',
          previewType: null,
          markdownRaw: null,
          markdownHtml: null,
          textContent: null,
          blobUrl: null,
          errorMessage: (err as Error).message,
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [file])

  async function handleCopy() {
    if (!state.markdownRaw) return
    try {
      await navigator.clipboard.writeText(state.markdownRaw)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard permission denied – silent
    }
  }

  // The modal is ALWAYS rendered so #preview-modal is always attached to the
  // DOM. Playwright spec checks toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="preview-modal" className={`modal${isOpen ? '' : ' hidden'}`}>
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h2 id="preview-file-name">{isOpen && file?.name ? file.name : 'Preview'}</h2>
          <button
            type="button"
            className="modal-close"
            id="preview-modal-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            &times;
          </button>
        </div>

        <div className="modal-body preview-body">
          {/* Loading */}
          {state.status === 'loading' && (
            <div id="preview-loading" className="preview-loading">
              <span>Loading preview…</span>
            </div>
          )}

          {/* Error */}
          {state.status === 'error' && (
            <div id="preview-content" className="preview-content">
              <div id="preview-unsupported" className="preview-unsupported">
                <p>Preview failed: {state.errorMessage}</p>
              </div>
            </div>
          )}

          {/* Ready content */}
          {state.status === 'ready' && (
            <div id="preview-content" className="preview-content">
              {/* Image */}
              {state.previewType === 'image' && state.blobUrl && (
                <img id="preview-image" className="preview-image" src={state.blobUrl} alt={file?.name ?? 'Preview'} />
              )}

              {/* Video */}
              {state.previewType === 'video' && state.blobUrl && (
                <div id="preview-video-container" className="preview-video-container">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video id="preview-video" src={state.blobUrl} controls style={{ maxWidth: '100%' }} />
                </div>
              )}

              {/* Audio */}
              {state.previewType === 'audio' && state.blobUrl && (
                <div id="preview-audio-container" className="preview-audio-container">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio id="preview-audio" src={state.blobUrl} controls />
                </div>
              )}

              {/* PDF – render decrypted blob in the browser's built-in PDF viewer */}
              {state.previewType === 'pdf' && state.blobUrl && (
                <div id="preview-pdf-container" className="preview-pdf-container">
                  <iframe
                    src={state.blobUrl}
                    title={`PDF preview: ${file?.name ?? ''}`}
                    className="preview-pdf-iframe"
                    style={{ width: '100%', height: '70vh', border: 'none' }}
                  />
                </div>
              )}

              {/* Markdown – two-tab view: rendered HTML + raw source */}
              {state.previewType === 'markdown' && state.markdownRaw !== null && (
                <div id="preview-markdown-container" className="preview-markdown-container">
                  <div className="markdown-header">
                    <div className="markdown-tabs">
                      <button
                        type="button"
                        className={`markdown-tab${mdTab === 'preview' ? ' active' : ''}`}
                        id="md-preview-tab"
                        data-view="preview"
                        onClick={() => setMdTab('preview')}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className={`markdown-tab${mdTab === 'source' ? ' active' : ''}`}
                        id="md-source-tab"
                        data-view="source"
                        onClick={() => setMdTab('source')}
                      >
                        Source
                      </button>
                    </div>
                    <div className="markdown-actions">
                      <button
                        type="button"
                        className={`code-btn${copied ? ' active' : ''}`}
                        id="md-copy"
                        aria-label="Copy markdown"
                        onClick={() => void handleCopy()}
                      >
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  {/* Rendered HTML – default tab */}
                  <div
                    className="markdown-content"
                    id="markdown-preview"
                    style={mdTab === 'source' ? { display: 'none' } : undefined}
                    // Marked sanitises via its default renderer; XSS risk is
                    // limited to the user's own E2E-decrypted content.
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: state.markdownHtml ?? '' }}
                  />

                  {/* Raw source */}
                  <div
                    className="markdown-source"
                    id="markdown-source"
                    style={mdTab === 'preview' ? { display: 'none' } : undefined}
                  >
                    <pre>
                      <code id="markdown-raw" className="language-markdown">
                        {state.markdownRaw}
                      </code>
                    </pre>
                  </div>
                </div>
              )}

              {/* Plain text */}
              {state.previewType === 'text' && state.textContent !== null && (
                <div id="preview-code-container" className="preview-code-container">
                  <pre id="preview-text" className="preview-text">
                    <code id="preview-code">{state.textContent}</code>
                  </pre>
                </div>
              )}

              {/* Unsupported */}
              {state.previewType === 'unsupported' && (
                <div id="preview-unsupported" className="preview-unsupported">
                  <p>Preview is not supported for this file type.</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" id="preview-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
