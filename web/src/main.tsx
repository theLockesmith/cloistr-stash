import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { installDebugConsole } from '@cloistr/ui'
import { ThemeProvider, SharedAuthProvider, ToastProvider } from '@cloistr/ui/components'
import { PwaUpdateNotice } from './components/PwaUpdateNotice'
import '@cloistr/ui/styles'
import App from './App'
import { StashProvider } from './state/StashProvider'
import { SIGNER_URL } from '@cloistr/stash-core/serviceConfig'
import './index.css'

// On-device console, opened with ?debug=1. It NO-OPS without that query
// parameter, so shipping it costs ordinary users nothing.
//
// It exists because stash upload failures reproduce only on a phone ("Failed to
// sign event: No relay connections available" on mobile while the identical
// action succeeds on desktop), and there was no way to read a console from the
// device. Several source-level theories were raised and refuted without anyone
// ever seeing what the client actually logged.
//
// Must run BEFORE render so it captures errors thrown during the first paint —
// which is exactly when auth and relay setup happen.
installDebugConsole()

// /public/{sha256}#{key} is a share link's reader page (src/public). It gets
// its own small tree: no sign-in, no PWA notice, no full app.
const PublicRoot = lazy(() => import('./public/PublicRoot'))
const isPublic = /^\/public\//.test(window.location.pathname)

// /embed/files is the file picker other Cloistr apps frame (src/embed). It
// gets its own small tree: no PWA notice (it must never register the
// service worker from inside a frame), no full app.
const EmbedRoot = lazy(() => import('./embed/EmbedRoot'))
const isEmbed = /^\/embed(\/|$)/.test(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  isPublic ? (
    <React.StrictMode>
      <Suspense fallback={null}>
        <PublicRoot />
      </Suspense>
    </React.StrictMode>
  ) : isEmbed ? (
    <React.StrictMode>
      <Suspense fallback={null}>
        <EmbedRoot />
      </Suspense>
    </React.StrictMode>
  ) : (
    <React.StrictMode>
      <ThemeProvider>
        <SharedAuthProvider signerUrl={SIGNER_URL}>
          <ToastProvider>
            <PwaUpdateNotice />
            <StashProvider>
              <App />
            </StashProvider>
          </ToastProvider>
        </SharedAuthProvider>
      </ThemeProvider>
    </React.StrictMode>
  ),
)
