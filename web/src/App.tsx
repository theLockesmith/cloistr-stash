import { useEffect } from 'react'
import { useNostrAuth } from '@cloistr/collab-common/auth'
import { Header, Footer, LoginPrompt } from '@cloistr/ui/components'
import { updateAuth, type Signer } from './lib/authBridge'

/**
 * Stash application shell.
 *
 * Chrome (Header/Footer) and auth (SharedAuthProvider + useNostrAuth) come from
 * the shared kit. An effect bridges the collab-common signer into the ported
 * data layer (keys/relay/relayprefs) via updateAuth(). The file-manager feature
 * surface is being ported from the legacy vanilla app (web/legacy/) module by
 * module; until then the authenticated view is a placeholder.
 */
export default function App() {
  const { authState, signer } = useNostrAuth()

  // Keep the data layer's auth port in sync with the shared signer/session.
  useEffect(() => {
    void updateAuth((signer as Signer | null) ?? null, {
      isConnected: !!authState?.isConnected,
      pubkey: authState?.pubkey ?? null,
    })
  }, [signer, authState?.isConnected, authState?.pubkey])

  return (
    <div className="stash-app">
      <Header activeServiceId="files" />
      <main className="stash-main">
        {authState?.isConnected ? (
          <section className="stash-placeholder">
            <h1>Stash</h1>
            <p>
              Signed in as <code>{authState.pubkey?.slice(0, 16)}…</code>
            </p>
            <p className="stash-muted">
              File browser is being migrated to React. Feature modules land here next.
            </p>
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
