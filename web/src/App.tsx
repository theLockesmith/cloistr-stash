import { useEffect, useState } from 'react'
import { useNostrAuth } from '@cloistr/collab-common/auth'
import { Header, Footer, LoginPrompt } from '@cloistr/ui/components'
import { updateAuth, type Signer } from './lib/authBridge'
import { useStash } from './state/useStash'
import { FileBrowser } from './components/FileBrowser'
import { Sidebar } from './components/Sidebar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'

/**
 * Stash application shell.
 *
 * Chrome (Header/Footer) and auth (SharedAuthProvider + useNostrAuth) come from
 * the shared kit. An effect bridges the collab-common signer into the ported
 * data layer (keys/relay/relayprefs) via updateAuth(), then loads the file
 * browser via the stash store. The file-manager UI is being ported module by
 * module (4b+); for now we render load status as proof the store is live.
 */
export default function App() {
  const { authState, signer } = useNostrAuth()
  const isConnected = !!authState?.isConnected
  const pubkey = authState?.pubkey ?? null
  const { loadFiles, loadFolderTree } = useStash()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Bridge the shared signer into the data layer, then load on connect.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await updateAuth((signer as Signer | null) ?? null, { isConnected, pubkey })
      if (cancelled) return
      if (isConnected && pubkey) {
        await loadFolderTree()
        await loadFiles()
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
            <Sidebar />
            {sidebarOpen && (
              <button
                type="button"
                className="sidebar-scrim"
                aria-label="Close navigation"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            <div className="stash-content">
              <div className="content-header">
                <button
                  type="button"
                  className="sidebar-toggle"
                  aria-label="Toggle navigation"
                  aria-expanded={sidebarOpen}
                  onClick={() => setSidebarOpen((o) => !o)}
                >
                  ☰
                </button>
                <Breadcrumbs />
              </div>
              <FileBrowser />
            </div>
            <KeyboardShortcuts />
          </div>
        ) : (
          <LoginPrompt
            title="Cloistr Stash"
            subtitle="Zero-knowledge encrypted file storage powered by Nostr"
          />
        )}
      </main>
      <Footer />
    </div>
  )
}
