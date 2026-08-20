import React from 'react'
import { createRoot } from 'react-dom/client'
import { installDebugConsole } from '@cloistr/ui'
import { ThemeProvider, SharedAuthProvider, ToastProvider } from '@cloistr/ui/components'
import '@cloistr/ui/styles'
import App from './App'
import { StashProvider } from './state/StashProvider'
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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <SharedAuthProvider>
        <ToastProvider>
          <StashProvider>
            <App />
          </StashProvider>
        </ToastProvider>
      </SharedAuthProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
