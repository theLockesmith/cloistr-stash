// NIP-46 connect dialog + stash landing page.
//
// Replaces the static <LoginPrompt> placeholder when the user is not
// authenticated. Replicates the legacy vanilla-JS landing screen and the
// bespoke NIP-46 modal that was lost in the React port (commit 108b68a).
//
// Spec note: the Playwright specs (auth.spec.js, landing.spec.js,
// ui-components.spec.js) assert exact legacy DOM ids (#connect-nip46,
// #nip46-modal, #bunker-url, #nip46-connect, #nip46-cancel,
// #nip46-modal-close, #nip46-status). All IDs are preserved here.
// The modal uses class toggling (.hidden) rather than conditional rendering
// so that the element is always present in the DOM, matching the spec
// assertions that check `toHaveClass(/hidden/)`.
//
// What is ported:
//   - Landing page structure (logo, title, tagline, features, auth buttons)
//   - NIP-46 modal with bunker:// / nostrconnect:// input
//   - Inline connecting spinner (#nip46-status)
//   - URL format validation with error feedback
//   - Enter-key shortcut on the bunker URL input
//   - Escape-key and Cancel-button to dismiss the modal
//   - Backdrop click to close
//
// What is intentionally NOT ported:
//   - NIP-07 extension connect button handler — delegated to the shared
//     Header LoginModal which the @cloistr/ui Header already provides via
//     the sign-in button; the #connect-nip07 button here calls connectNip07()
//     directly via useNostrAuth() for the same result.
//   - Session restore (hasSavedSession / restoreSession) — @cloistr/auth's
//     AuthProvider already handles auto-restore on mount via its `autoRestore`
//     prop (set in SharedAuthProvider), so no manual call is needed here.
//   - The legacy toast class ".toast.error" — @cloistr/ui's ToastProvider
//     renders ".cloistr-toast .cloistr-toast-error"; the pre-existing
//     mismatch is a spec-vs-shared-kit gap, not something this port can
//     resolve without going out of scope.

import { useState, useRef, useEffect, useCallback } from 'react'
import { useNostrAuth } from '@cloistr/auth'
import { useToast } from '@cloistr/ui/components'

type NIP46Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

export function NIP46Dialog() {
  const { connectNip07, connectNip46 } = useNostrAuth()
  const { error: toastError } = useToast()

  const [modalOpen, setModalOpen] = useState(false)
  const [bunkerUrl, setBunkerUrl] = useState('')
  const [status, setStatus] = useState<NIP46Status>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)
  const connectBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the bunker input when the modal opens.
  useEffect(() => {
    if (modalOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [modalOpen])

  const openModal = () => {
    setBunkerUrl('')
    setStatus({ kind: 'idle' })
    setModalOpen(true)
  }

  const closeModal = useCallback(() => {
    if (status.kind === 'connecting') return // don't dismiss while in flight
    setModalOpen(false)
    setStatus({ kind: 'idle' })
  }, [status.kind])

  // Escape key closes the modal.
  useEffect(() => {
    if (!modalOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [modalOpen, closeModal])

  const handleConnectNip07 = async () => {
    try {
      await connectNip07()
    } catch (err) {
      toastError((err as Error).message ?? 'Failed to connect with extension')
    }
  }

  const handleConnectNip46 = async () => {
    const url = bunkerUrl.trim()

    if (!url) {
      toastError('Please enter a bunker URL')
      return
    }
    if (!url.startsWith('bunker://') && !url.startsWith('nostrconnect://')) {
      toastError('Invalid bunker URL. Must start with bunker:// or nostrconnect://')
      return
    }

    setStatus({ kind: 'connecting' })
    if (connectBtnRef.current) connectBtnRef.current.disabled = true

    try {
      await connectNip46({ bunkerUrl: url })
      setStatus({ kind: 'success' })
      // Auth state update in App.tsx will swap the landing page out.
      // Close the modal cleanly in case of any race.
      setModalOpen(false)
    } catch (err) {
      const msg = (err as Error).message ?? 'Connection failed'
      setStatus({ kind: 'error', message: msg })
      toastError(`Connection failed: ${msg}`)
    } finally {
      if (connectBtnRef.current) connectBtnRef.current.disabled = false
    }
  }

  const handleBunkerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleConnectNip46()
    }
  }

  // Clicking the backdrop (the outermost modal div) closes the modal.
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeModal()
  }

  // Derive the #nip46-status CSS classes from the current status.
  const statusClass = [
    'nip46-status',
    status.kind === 'idle' ? 'hidden' : '',
    status.kind === 'error' ? 'error' : '',
    status.kind === 'success' ? 'success' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="landing">
      <div className="landing-hero landing-container">
        {/* Brand */}
        <div className="landing-brand">
          <img src="/favicon.svg" alt="Stash" className="landing-logo" />
          <span className="landing-title">Cloistr Stash</span>
        </div>

        <p className="landing-tagline">Nostr-native file storage. Own your data.</p>

        {/* Feature cards */}
        <div className="landing-features">
          <div className="feature">
            <div className="feature-icon">🔐</div>
            <h3>Self-Sovereign</h3>
            <p>Files signed with your Nostr identity. No accounts, no passwords.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">📁</div>
            <h3>Organized</h3>
            <p>Folders, drag-and-drop, and familiar file management.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🔗</div>
            <h3>Decentralized</h3>
            <p>Your files, stored on Blossom servers you choose.</p>
          </div>
        </div>

        {/* Auth buttons */}
        <div className="landing-auth">
          <button
            id="connect-nip07"
            type="button"
            className="btn btn-primary btn-large"
            onClick={() => void handleConnectNip07()}
          >
            Connect with Extension
          </button>
          <button
            id="connect-nip46"
            type="button"
            className="btn btn-secondary btn-large"
            onClick={openModal}
          >
            Connect with Remote Signer
          </button>
          <p className="auth-help">
            Need a Nostr identity?{' '}
            <a href="https://signer.cloistr.xyz" target="_blank" rel="noopener noreferrer">
              Get one at signer.cloistr.xyz
            </a>
          </p>
        </div>
      </div>

      {/* NIP-46 modal — always in the DOM; visibility toggled via .hidden class */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        id="nip46-modal"
        className={`modal${modalOpen ? '' : ' hidden'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nip46-modal-title"
        onClick={handleBackdropClick}
      >
        <div className="modal-content modal-small">
          <div className="modal-header">
            <h2 id="nip46-modal-title">Connect with Remote Signer</h2>
            <button
              id="nip46-modal-close"
              type="button"
              className="modal-close"
              aria-label="Close modal"
              onClick={closeModal}
            >
              &times;
            </button>
          </div>

          <div className="modal-body">
            <p className="modal-description">Enter your bunker connection string:</p>
            <input
              ref={inputRef}
              id="bunker-url"
              type="text"
              className="input"
              placeholder="bunker://..."
              autoComplete="off"
              value={bunkerUrl}
              onChange={(e) => setBunkerUrl(e.target.value)}
              onKeyDown={handleBunkerKeyDown}
            />
            <p className="modal-help">
              Get a bunker URL from{' '}
              <a href="https://signer.cloistr.xyz" target="_blank" rel="noopener noreferrer">
                signer.cloistr.xyz
              </a>{' '}
              or other remote signers like{' '}
              <a href="https://nsec.app" target="_blank" rel="noopener noreferrer">
                nsec.app
              </a>
            </p>

            {/* Status area — always rendered; hidden via CSS class when idle */}
            <div id="nip46-status" className={statusClass}>
              {status.kind === 'connecting' && (
                <>
                  <div className="spinner" aria-hidden="true" />
                  <span>Connecting to remote signer...</span>
                </>
              )}
              {status.kind === 'success' && (
                <span>Connected! Verifying authorization...</span>
              )}
              {status.kind === 'error' && (
                <span>Connection failed: {status.message}</span>
              )}
            </div>
          </div>

          <div className="modal-footer">
            <button
              id="nip46-cancel"
              type="button"
              className="btn"
              onClick={closeModal}
            >
              Cancel
            </button>
            <button
              ref={connectBtnRef}
              id="nip46-connect"
              type="button"
              className="btn btn-primary"
              onClick={() => void handleConnectNip46()}
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
