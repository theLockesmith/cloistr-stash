import { useEffect, useState } from 'react'
import { useNostrAuth } from '@cloistr/auth'
import { Header, Footer, Spinner, useSharedSession } from '@cloistr/ui/components'
import { updateAuth, type Signer } from './lib/authBridge'
import { useStash } from './state/useStash'
import { FileBrowser } from './components/FileBrowser'
import { Sidebar } from './components/Sidebar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { NotificationsModal } from './components/NotificationsModal'
import { UploadButton, UploadProgress } from './components/UploadBar'
import { SearchBar } from './components/SearchBar'
import { NewButton } from './components/NewButton'
import { NewFolderModal } from './components/NewFolderModal'
import { MigrationModal } from './components/MigrationModal'
import { BackupModal } from './components/BackupModal'
import { ActivityModal } from './components/ActivityModal'
import { NIP46Dialog } from './components/NIP46Dialog'
import { Search } from './lib/search'
import { Sharing } from './lib/sharing'
import { Versioning } from './lib/versioning'
import { Collaboration } from './lib/collaboration'
import { API } from './lib/api'
import { Keys } from './lib/keys'
import { Crypto } from './lib/crypto'

/**
 * Stash application shell.
 *
 * Chrome (Header/Footer) and auth (SharedAuthProvider + useNostrAuth) come from
 * the shared kit. An effect bridges the collab-common signer into the ported
 * data layer (keys/relay/relayprefs) via updateAuth(), then loads the file
 * browser via the stash store. The file-manager UI is being ported module by
 * module (4b+); for now we render load status as proof the store is live.
 *
 * The unauthenticated state now renders NIP46Dialog — the ported landing page +
 * NIP-46 remote-signer connect flow — replacing the static LoginPrompt placeholder.
 */
export default function App() {
  const { authState, signer } = useNostrAuth()
  const isConnected = !!authState?.isConnected
  const pubkey = authState?.pubkey ?? null
  // Auth has THREE states, not two. Rendering the landing page whenever
  // `isConnected` is false meant that every connect — and every page-to-page
  // navigation while the shared session re-resolved — flashed the sign-in
  // screen (and its bunker:// modal) at an already-signed-in user, which reads
  // as "you got logged out".
  //
  // SharedAuthProvider gates its own first render while the silent SSO restore
  // runs, but that gate ends when `isResolving` clears; the NIP-46 handshake
  // itself happens afterwards under `isConnecting`. Both windows need the same
  // affordance, so treat them as one "connecting" state.
  const { isResolving } = useSharedSession()
  const isConnecting = !!authState?.isConnecting || !!authState?.isSwitching || isResolving
  const { loadFiles, loadFolderTree, uploadFiles, view, currentFolderId, migrationFiles, dismissMigration } = useStash()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // SEPARATE from sidebarOpen, deliberately. sidebarOpen is the MOBILE drawer
  // and must default closed; this is the DESKTOP rail collapsing to icons and
  // is a persisted preference. One boolean drove both, which is why the desktop
  // toggle only ever showed the backdrop: it flipped the drawer state on a
  // breakpoint where the drawer does not exist, so the page went dark with
  // nothing behind it.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('stash:sidebarCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)

  const toggleSidebar = () => setSidebarOpen((o) => !o)
  const toggleCollapsed = () =>
    setSidebarCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem('stash:sidebarCollapsed', next ? '1' : '0')
      } catch {
        // Preference only — never block the toggle on storage being unavailable.
      }
      return next
    })
  const closeSidebar = () => setSidebarOpen(false)

  // Bridge the shared signer into the data layer, then load on connect.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await updateAuth((signer as Signer | null) ?? null, { isConnected, pubkey })
      if (cancelled) return
      if (isConnected && pubkey) {
        // Wire Collaboration's injected deps before init so that saveDocument,
        // createVersion, and shareFile all resolve against the live API.
        Collaboration.configure({
          downloadFileData: async (file) => {
            const f = file as Record<string, unknown>
            const sha256 = f.sha256 as string | undefined
            if (!sha256) return null
            const fileId = (f.file_id ?? f.fileId ?? f.d ?? f.id) as string | undefined
            const folderId = (f.folder_id ?? f.folderId ?? f.folder ?? null) as string | null
            if (!fileId) return null
            const downloadUrl = API.getDownloadURL(sha256)
            const resp = await fetch(downloadUrl)
            if (!resp.ok) return null
            const encryptedData = await resp.arrayBuffer()
            const fileKey = folderId
              ? await Keys.deriveFileKey(folderId, fileId)
              : await Keys.deriveRootFileKey(fileId)
            const decrypted = await Crypto.decryptFile(encryptedData, fileKey)
            Crypto.wipeKey(fileKey)
            return decrypted
          },
          createVersion: (file, data, opts) =>
            Versioning.createVersion(
              file as Parameters<typeof Versioning.createVersion>[0],
              data,
              opts,
            ).then(() => undefined),
          autoSaveVersion: (file, data) =>
            Versioning.autoSaveVersion(
              file as Parameters<typeof Versioning.autoSaveVersion>[0],
              data,
            ).then(() => undefined),
          shareFile: (file, recipientPubkey, opts) =>
            Sharing.shareFile(
              file as Parameters<typeof Sharing.shareFile>[0],
              recipientPubkey,
              opts,
            ).then(() => undefined),
        })
        // Initialize the encrypted feature stores (idempotent; Keys is ready
        // after updateAuth). Non-fatal if any fails.
        try {
          await Promise.all([Search.init(pubkey), Sharing.init(), Versioning.init(), Collaboration.init()])
        } catch (err) {
          console.warn('Feature module init failed:', err)
        }
        if (cancelled) return
        await loadFolderTree()
        await loadFiles()
      } else if (!isConnected) {
        Search.clearKey()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [signer, isConnected, pubkey, loadFiles, loadFolderTree])

  return (
    <div className="stash-app">
      <Header activeServiceId="files" />
      <main className="stash-main">
        {isConnected ? (
          <div
            className={`stash-workspace ${sidebarOpen ? 'sidebar-open' : ''}${
              sidebarCollapsed ? ' sidebar-collapsed' : ''
            }`}
          >
            <Sidebar
              isOpen={sidebarOpen}
              collapsed={sidebarCollapsed}
              onToggle={toggleCollapsed}
              onClose={closeSidebar}
              onOpenNotifications={() => setNotificationsOpen(true)}
              onOpenActivity={() => setActivityOpen(true)}
            />
            {/* Overlay: always in DOM so tests can find #sidebar-overlay; visible class shows it */}
            <div
              id="sidebar-overlay"
              className={`sidebar-overlay${sidebarOpen ? ' visible' : ''}`}
              role="button"
              tabIndex={-1}
              aria-label="Close navigation"
              onClick={closeSidebar}
              onKeyDown={(e) => { if (e.key === 'Escape') closeSidebar() }}
            />
            <div
              className="stash-content"
              onDragOver={(e) => {
                if (view === 'my-files') e.preventDefault()
              }}
              onDrop={(e) => {
                if (view !== 'my-files') return
                e.preventDefault()
                const dropped = Array.from(e.dataTransfer.files)
                if (dropped.length > 0) void uploadFiles(dropped)
              }}
            >
              <div className="content-header">
                {/* Mobile-only hamburger: inline display:none overridden by CSS on ≤768px */}
                <button
                  id="mobile-menu-btn"
                  type="button"
                  className="mobile-menu-btn"
                  title="Menu"
                  aria-label="Open navigation"
                  style={{ display: 'none' }}
                  onClick={toggleSidebar}
                >
                  ☰
                </button>
                <Breadcrumbs />
                <span className="content-header-spacer" />
                {view === 'my-files' && (
                  <NewButton onNewFolder={() => setNewFolderOpen(true)} />
                )}
                <SearchBar />
                <UploadButton />
                <button
                  type="button"
                  id="backup-btn"
                  className="backup-trigger-btn"
                  title="Key Backup"
                  aria-label="Key Backup"
                  onClick={() => setBackupOpen(true)}
                >
                  🔑
                </button>
              </div>
              <FileBrowser />
            </div>
            <UploadProgress />
            {/* New Folder modal — always in DOM; visibility via .hidden class. */}
            <NewFolderModal
              open={newFolderOpen}
              onClose={() => setNewFolderOpen(false)}
            />
            {/* Folder Customize modal stub — structure required by spec. */}
            <div id="folder-customize-modal" className="modal hidden">
              <div className="modal-content modal-small">
                <div className="modal-header">
                  <h2>Customize Folder</h2>
                  <button type="button" className="modal-close" id="folder-customize-close">&times;</button>
                </div>
                <div className="modal-body">
                  <div id="customize-folder-name" className="folder-name-display" />
                  <div className="customize-section">
                    <span>Color</span>
                    <div id="folder-color-picker" className="color-picker" />
                  </div>
                  <div className="customize-section">
                    <span>Icon</span>
                    <div id="folder-icon-picker" className="icon-picker" />
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn" id="folder-customize-reset">Reset</button>
                  <button type="button" className="btn btn-primary" id="folder-customize-save">Save</button>
                </div>
              </div>
            </div>
            <KeyboardShortcuts onNewFolder={() => setNewFolderOpen(true)} />
            <MigrationModal
              unencryptedFiles={migrationFiles}
              folderId={currentFolderId}
              onClose={dismissMigration}
              onComplete={() => {
                dismissMigration()
                void loadFiles()
              }}
            />
            <BackupModal isOpen={backupOpen} onClose={() => setBackupOpen(false)} />
            <ActivityModal isOpen={activityOpen} onClose={() => setActivityOpen(false)} />
            <NotificationsModal
              open={notificationsOpen}
              onClose={() => setNotificationsOpen(false)}
            />
          </div>
        ) : isConnecting ? (
          /* Connecting: plain-language status, no protocol jargon. The
             technical detail (method, key, error) is available behind a
             disclosure for when something goes wrong. */
          <div className="stash-connecting" role="status" aria-busy="true">
            <Spinner size="xl" label="Connecting" />
            <p className="stash-connecting-title">Connecting to your account…</p>
            <p className="stash-connecting-hint">
              Approve the request in your signer if prompted.
            </p>
            <details className="stash-connecting-details">
              <summary>See more</summary>
              <dl>
                <dt>Method</dt>
                <dd>{authState?.method ?? 'resolving shared session'}</dd>
                <dt>Identity</dt>
                <dd>{pubkey ? `${pubkey.slice(0, 12)}…${pubkey.slice(-6)}` : 'not resolved yet'}</dd>
                <dt>Stage</dt>
                <dd>
                  {isResolving
                    ? 'restoring your session across cloistr.xyz'
                    : authState?.isSwitching
                      ? 'switching identity'
                      : 'completing the signer handshake (NIP-46)'}
                </dd>
                {authState?.error ? (
                  <>
                    <dt>Last error</dt>
                    <dd>{authState.error}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          </div>
        ) : (
          <NIP46Dialog />
        )}
      </main>
      <Footer />
    </div>
  )
}
