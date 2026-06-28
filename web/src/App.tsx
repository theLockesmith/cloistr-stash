import { useEffect } from 'react'
import { useNostrAuth } from '@cloistr/collab-common/auth'
import { Header, Footer, LoginPrompt } from '@cloistr/ui/components'
import { updateAuth, type Signer } from './lib/authBridge'
import { useStash } from './state/useStash'

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
  const { loadFiles, loadFolderTree, files, folders, loading, error } = useStash()

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
          <section className="stash-placeholder">
            <h1>Stash</h1>
            <p>
              Signed in as <code>{pubkey?.slice(0, 16)}…</code>
            </p>
            {loading ? (
              <p className="stash-muted">Loading…</p>
            ) : error ? (
              <p className="stash-muted">{error}</p>
            ) : (
              <p className="stash-muted">
                {folders.length} folder{folders.length === 1 ? '' : 's'}, {files.length} file
                {files.length === 1 ? '' : 's'} in this view. File browser UI ports next (4b).
              </p>
            )}
          </section>
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
