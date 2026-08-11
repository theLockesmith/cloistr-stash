// Encryption info modal – ported from legacy showEncryptionInfo() in app.js.
//
// Legacy behaviour reproduced here:
//   • showEncryptionInfo(file) showed algorithm, key hierarchy, and storage info.
//   • Key hierarchy differed based on whether the file lived in a folder
//     (Root → Folder Key → File Key) or at root level (Root → File Key).
//   • The function was defined in the legacy code but never wired to a UI
//     trigger. This port adds an "Encryption Info" item to the per-file
//     action menu so users can reach it.
//
// Wording updated to describe the CURRENT implementation accurately:
//   • File encryption: XChaCha20-Poly1305 via libsodium (unchanged from legacy).
//   • Key wrapping: NIP-44 self-encryption (NIP-04 accepted on read for legacy
//     data). The legacy code used NIP-04 only; the current implementation
//     prefers NIP-44 writes when the signer supports it.
//   • Key derivation: HKDF-SHA-256 with a zero 32-byte salt and context strings
//     (cloistr-drive-*-v1). Unchanged from legacy.
//   • Keys are stored in IndexedDB encrypted to the user's own public key and
//     also persisted as a Nostr event (kind 30078, d='root-key') for
//     cross-device recovery. The legacy description ("stored locally only") was
//     inaccurate.
//
// Deliberately left out:
//   • The "Storage" section wording from the legacy code stated that keys were
//     stored locally only; the current implementation also publishes the root
//     key to Nostr relays (self-encrypted). The wording below reflects reality.
//
// DOM structure intentionally matches the Playwright spec
// (tests/e2e/modals-features.spec.js):
//   #encryption-info-modal  →  always attached, class includes "hidden" when closed
//   .modal-header h2        →  text "Encryption Details"
//   #encryption-info-close  →  close button
//   .encryption-info-section (Algorithm)  →  .encryption-algorithm "XChaCha20-Poly1305"
//   .encryption-info-section (Key Derivation)  →  #key-hierarchy
//   #encryption-info-done   →  "Done" button in footer

import type { StashFile } from '../state/types'

function folderId(file: StashFile): string | null {
  return (
    (file.folder as string | undefined) ||
    (file as Record<string, unknown>).folder_id as string | undefined ||
    (file as Record<string, unknown>).folderId as string | undefined ||
    null
  )
}

function KeyHierarchy({ file }: { file: StashFile | null }) {
  if (!file) return null
  const inFolder = !!folderId(file)

  if (inFolder) {
    return (
      <div id="key-hierarchy" className="key-hierarchy">
        <div className="key-node key-node-root">
          <span className="key-node-icon">&#128273;</span>
          <span className="key-node-label">Root Key</span>
          <span className="key-node-desc">Master key, self-encrypted via NIP-44 on your relay</span>
        </div>
        <div className="key-arrow">&#8595;</div>
        <div className="key-node key-node-folder">
          <span className="key-node-icon">&#128193;</span>
          <span className="key-node-label">Folder Key</span>
          <span className="key-node-desc">Derived via HKDF-SHA-256</span>
        </div>
        <div className="key-arrow">&#8595;</div>
        <div className="key-node key-node-file">
          <span className="key-node-icon">&#128196;</span>
          <span className="key-node-label">File Key</span>
          <span className="key-node-desc">Unique per file, derived via HKDF-SHA-256</span>
        </div>
      </div>
    )
  }

  return (
    <div id="key-hierarchy" className="key-hierarchy">
      <div className="key-node key-node-root">
        <span className="key-node-icon">&#128273;</span>
        <span className="key-node-label">Root Key</span>
        <span className="key-node-desc">Master key, self-encrypted via NIP-44 on your relay</span>
      </div>
      <div className="key-arrow">&#8595;</div>
      <div className="key-node key-node-file">
        <span className="key-node-icon">&#128196;</span>
        <span className="key-node-label">File Key</span>
        <span className="key-node-desc">Derived directly from root via HKDF-SHA-256</span>
      </div>
    </div>
  )
}

export interface EncryptionInfoModalProps {
  file: StashFile | null
  onClose: () => void
}

export function EncryptionInfoModal({ file, onClose }: EncryptionInfoModalProps) {
  const isOpen = !!file

  // The modal is ALWAYS rendered so #encryption-info-modal is always attached
  // to the DOM. Playwright spec checks toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="encryption-info-modal" className={`modal${isOpen ? '' : ' hidden'}`}>
      <div className="modal-content modal-small">
        <div className="modal-header">
          <h2>Encryption Details</h2>
          <button
            type="button"
            className="modal-close"
            id="encryption-info-close"
            onClick={onClose}
            aria-label="Close encryption details"
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="encryption-status-box">
            <span className="encryption-icon-large">&#128274;</span>
            <span className="encryption-status-text">End-to-End Encrypted</span>
          </div>

          <div className="encryption-info-section">
            <h4>Algorithm</h4>
            <p className="encryption-algorithm">XChaCha20-Poly1305</p>
          </div>

          <div className="encryption-info-section">
            <h4>Key Derivation</h4>
            <KeyHierarchy file={file} />
          </div>

          <div className="encryption-info-section">
            <h4>Storage</h4>
            <p className="encryption-storage-info">
              Your encryption keys are stored locally in your browser (IndexedDB),
              protected by your Nostr identity via NIP-44 self-encryption. The root
              key is also published as an encrypted Nostr event so you can recover
              access from any device. The server never sees your keys or unencrypted
              data.
            </p>
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-primary"
            id="encryption-info-done"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
