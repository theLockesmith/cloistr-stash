import { useEffect, useState } from 'react'
import { useNostrAuth } from '@cloistr/auth'
import { Header, Footer } from '@cloistr/ui/components'
import { updateAuth, type Signer } from './lib/authBridge'
import { useStash } from './state/useStash'
import { FileBrowser } from './components/FileBrowser'
import { Sidebar } from './components/Sidebar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { NotificationsModal } from './components/NotificationsModal'
import { UploadButton, UploadProgress } from './components/UploadBar'
import { SearchBar } from './components/SearchBar'
import { MigrationModal } from './components/MigrationModal'
import { ActivityModal } from './components/ActivityModal'
import { NIP46Dialog } from './components/NIP46Dialog'
import { Search } from './lib/search'
import { Sharing } from './lib/sharing'
import { Versioning } from './lib/versioning'
import { Collaboration } from './lib/collaboration'

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
  const { loadFiles, loadFolderTree, uploadFiles, view, currentFolderId, migrationFiles, dismissMigration } = useStash()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)

  const toggleSidebar = () => setSidebarOpen((o) => !o)
  const closeSidebar = () => setSidebarOpen(false)

  // Bridge the shared signer into the data layer, then load on connect.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await updateAuth((signer as Signer | null) ?? null, { isConnected, pubkey })
      if (cancelled) return
      if (isConnected && pubkey) {
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
          <div className={`stash-workspace ${sidebarOpen ? 'sidebar-open' : ''}`}>
            <Sidebar
              isOpen={sidebarOpen}
              onToggle={toggleSidebar}
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
                <SearchBar />
                <UploadButton />
              </div>
              <FileBrowser />
            </div>
            <UploadProgress />
            <KeyboardShortcuts />
            <MigrationModal
              unencryptedFiles={migrationFiles}
              folderId={currentFolderId}
              onClose={dismissMigration}
              onComplete={() => {
                dismissMigration()
                void loadFiles()
              }}
            />
            <ActivityModal isOpen={activityOpen} onClose={() => setActivityOpen(false)} />
            <NotificationsModal
              open={notificationsOpen}
              onClose={() => setNotificationsOpen(false)}
            />
          </div>
        ) : (
          <NIP46Dialog />
        )}
      </main>
      <Footer />
    </div>
  )
}
