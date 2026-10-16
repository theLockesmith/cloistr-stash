// Entry for /embed/files. The parent is checked BEFORE anything else runs:
// a refused embed starts no sign-in, reads no key and posts nothing.

import { ThemeProvider, SharedAuthProvider } from '@cloistr/ui/components'
import { SIGNER_URL } from '@cloistr/stash-core/serviceConfig'
import { EmbedApp } from './EmbedApp'
import { EmbedView } from './EmbedView'
import { allowedParents, checkParent } from './protocol'
import '@cloistr/ui/styles'
import './embed.css'

const noop = () => {}

export default function EmbedRoot() {
  const check = checkParent({
    search: window.location.search,
    framed: window.parent !== window,
    allowed: allowedParents((window as { __CLOISTR_CONFIG__?: unknown }).__CLOISTR_CONFIG__),
    ancestorOrigins: window.location.ancestorOrigins ?? null,
  })
  if (!check.ok) {
    return (
      <ThemeProvider>
        <EmbedView
          state={{ kind: 'refused', reason: check.reason }}
          mode="browse"
          appUrl={window.location.origin}
          selected={new Set()}
          onOpenFolder={noop}
          onToggleFile={noop}
          onChoose={noop}
          onCancel={noop}
          onRetry={noop}
        />
      </ThemeProvider>
    )
  }
  return (
    <ThemeProvider>
      <SharedAuthProvider signerUrl={SIGNER_URL}>
        <EmbedApp parent={check.parent} mode={check.mode} />
      </SharedAuthProvider>
    </ThemeProvider>
  )
}
