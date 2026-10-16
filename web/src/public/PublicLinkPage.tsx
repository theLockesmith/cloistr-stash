// The page a public share link opens. See publicLink.ts for how the file is
// fetched and decrypted.

import { useEffect, useState } from 'react'
import { openPublicLink, parsePublicLink, type ParsedLink } from './publicLink'

const REASONS: Record<Extract<ParsedLink, { ok: false }>['reason'], string> = {
  'bad-path': 'This is not a valid share link.',
  'no-key': 'This link is missing its key (the part after #). Ask for the full link.',
  'bad-key': 'This link’s key is damaged. Ask for the full link.',
}

/**
 * Read the key once, then take it out of the address bar and history, so it
 * is not left where a later copy, bookmark or extension would pick it up.
 * The fragment is never sent to a server; this only shortens its life here.
 */
export function readAndClearLink(): ParsedLink {
  const parsed = parsePublicLink(window.location.pathname, window.location.hash)
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname)
  }
  return parsed
}

export function PublicLinkPage({ parsed }: { parsed: ParsedLink }) {
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; text: string }>({
    kind: 'idle',
    text: '',
  })
  const [fileName, setFileName] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Shared file · Cloistr Stash'
  }, [])

  async function download() {
    if (!parsed.ok) return
    setStatus({ kind: 'busy', text: 'Downloading and decrypting…' })
    try {
      const file = await openPublicLink(parsed.link)
      setFileName(file.name)
      const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mimeType }))
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setStatus({ kind: 'done', text: 'Download complete.' })
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message })
    }
  }

  return (
    <main className="public-link">
      <div className="public-link__card">
        <div className="public-link__logo" aria-hidden="true">
          🔐
        </div>
        <h1>{fileName ?? 'Encrypted file'}</h1>
        {parsed.ok ? (
          <>
            <p>This file is end-to-end encrypted. It is decrypted in your browser; the key in the link never reaches Stash.</p>
            <button
              type="button"
              className="public-link__button"
              onClick={() => void download()}
              disabled={status.kind === 'busy'}
            >
              Download &amp; decrypt
            </button>
          </>
        ) : (
          <p role="alert">{REASONS[parsed.reason]}</p>
        )}
        {status.text && (
          <p className={`public-link__status${status.kind === 'error' ? ' public-link__status--error' : ''}`} role="status">
            {status.text}
          </p>
        )}
      </div>
    </main>
  )
}
