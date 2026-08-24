import { useEffect, useState, useRef } from 'react'
import { useNostrAuth } from '@cloistr/auth'
import { Header, Footer, Spinner, useSharedSession } from '@cloistr/ui/components'
import { AppShell } from '@cloistr/ui/components'
import type { MenuSection } from '@cloistr/ui/components'
import { updateAuth, type Signer } from './lib/authBridge'
import { SignerRecovery } from '@cloistr/ui/components'
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
 *
 * Navigation: AppShell owns the single mobile hamburger. The sidebar nav (views
 * + folder tree) goes into AppShell's `nav` prop. Actions go into `menu`. On
 * mobile, one drawer contains both. On desktop, the sidebar is in-flow and the
 * menu is a horizontal bar — no hamburger.
 */

/**
 * Build the AppShell menu for a given state.
 *
 * All callbacks come from App state so they reach the mobile drawer and the
 * desktop menu bar from the same definition. Menu items that depend on state
 * (e.g. New Folder only makes sense in my-files) map to disabled items with
 * `disabledReason` rather than hidden items or enabled no-ops.
 */
export function buildStashMenu(opts: {
  view: string
  onNewFolder: () => void
  onBackup: () => void
  onNotifications: () => void
  onActivity: () => void
}): MenuSection[] {
  return [
    {
      label: 'Actions',
      items: [
        opts.view === 'my-files'
          ? { label: 'New Folder', onSelect: opts.onNewFolder }
          : { label: 'New Folder', disabledReason: 'Only available in My Files' },
        { label: 'Key Backup', onSelect: opts.onBackup },
        { separator: true } as const,
        { label: 'Notifications', onSelect: opts.onNotifications },
        { label: 'Activity Log', onSelect: opts.onActivity },
      ],
    },
  ]
}

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

  /**
   * A connect attempt that STARTED and then ended without connecting.
   *
   * Previously a failed or timed-out NIP-46 handshake simply made isConnecting
   * false while isConnected stayed false, so the app fell through to the
   * signed-out landing page with no error, no retry and no explanation. Measured
   * on the deployed app: "Connecting to your account…" at 8s and 16s, then the
   * Sign In page at 26s, on a session that was perfectly valid. That is the
   * reported "it stops accepting my login" — the session was never invalid, the
   * handshake just gave up and the UI called it logged out.
   *
   * A signing or connection failure is NOT an authentication failure, so it must
   * not be presented as one.
   */
  const [connectFailed, setConnectFailed] = useState(false)
  const wasConnecting = useRef(false)
  useEffect(() => {
    if (isConnecting) {
      wasConnecting.current = true
      setConnectFailed(false)
      return
    }
    if (wasConnecting.current && !isConnected) {
      wasConnecting.current = false
      setConnectFailed(true)
    }
  }, [isConnecting, isConnected])
  const { loadFiles, loadFolderTree, uploadFiles, uploadDirectory, view, currentFolderId, migrationFiles, dismissMigration } = useStash()
  // DESKTOP only: persisted preference for the sidebar rail width.
  // AppShell owns the mobile drawer; this controls the desktop aside only.
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
  // Folder-upload error notice (e.g. auth not ready when a folder is dropped).
  const [folderUploadError, setFolderUploadError] = useState<string | null>(null)

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

  // Menu sections built from live state so both the desktop menu bar and the
  // mobile drawer sections reflect the same callbacks and disabled states.
  const menu = isConnected
    ? buildStashMenu({
        view,
        onNewFolder: () => setNewFolderOpen(true),
        onBackup: () => setBackupOpen(true),
        onNotifications: () => setNotificationsOpen(true),
        onActivity: () => setActivityOpen(true),
      })
    : undefined

  return (
    <div className="stash-app">
      <Header activeServiceId="files" />
      <main className="stash-main">
        {isConnected ? (
          <AppShell
            serviceId="stash"
            nav={
              <Sidebar
                collapsed={sidebarCollapsed}
                onToggle={toggleCollapsed}
                onOpenNotifications={() => setNotificationsOpen(true)}
                onOpenActivity={() => setActivityOpen(true)}
              />
            }
            menu={menu}
          >
            <div
              className="stash-content"
              onDragOver={(e) => {
                if (view === 'my-files') e.preventDefault()
              }}
              onDrop={(e) => {
                if (view !== 'my-files') return
                e.preventDefault()
                // Use the FileSystem API (webkitGetAsEntry) to distinguish files
                // from directories. A plain File API drop produces an empty FileList
                // for folders, so the items API is mandatory here.
                const items = Array.from(e.dataTransfer.items)
                const entries = items
                  .map((item) => item.webkitGetAsEntry?.())
                  .filter((entry): entry is FileSystemEntry => entry !== null && entry !== undefined)

                if (entries.length === 0) {
                  // Fallback: no FileSystem API support (very old browsers).
                  const dropped = Array.from(e.dataTransfer.files)
                  if (dropped.length > 0) void uploadFiles(dropped)
                  return
                }

                const hasDirectory = entries.some((e) => e.isDirectory)
                if (hasDirectory) {
                  // Hand the entire entry list to uploadDirectory, which will
                  // recursively create sub-folders and upload files.
                  void uploadDirectory(entries)
                  return
                }

                // All entries are files — unwrap them via getFile() for consistency.
                const filePromises = entries
                  .filter((entry) => entry.isFile)
                  .map((entry) => new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)))
                void Promise.all(filePromises).then((files) => {
                  if (files.length > 0) void uploadFiles(files)
                })
              }}
            >
              <div className="content-header">
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
              {folderUploadError && (
                <div
                  role="alert"
                  className="folder-drop-notice"
                  onClick={() => setFolderUploadError(null)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setFolderUploadError(null) }}
                  tabIndex={0}
                  aria-label="Dismiss notice"
                >
                  {folderUploadError}
                  <button
                    type="button"
                    className="folder-drop-notice-close"
                    aria-label="Dismiss"
                    onClick={(e) => { e.stopPropagation(); setFolderUploadError(null) }}
                  >
                    &times;
                  </button>
                </div>
              )}
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
          </AppShell>
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
        ) : connectFailed ? (
          /* Reaching your signer failed. Offer a way forward and a way back,
             and NEVER a credential prompt: the session is still valid, so
             sending the user to sign in again would be both wrong and the exact
             habit a key-based product must not build. */
          <SignerRecovery
            error={authState?.error ?? { code: 'CONNECTION_FAILED' }}
            retrying={isConnecting}
            onRetry={() => {
              setConnectFailed(false)
              window.location.reload()
            }}
            onGoBack={() => setConnectFailed(false)}
          />
        ) : (
          <NIP46Dialog />
        )}
      </main>
      <Footer />
    </div>
  )
}
