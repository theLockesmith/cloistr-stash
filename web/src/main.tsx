import React from 'react'
import { createRoot } from 'react-dom/client'
import { installDebugConsole } from '@cloistr/ui'
import { ThemeProvider, SharedAuthProvider, ToastProvider } from '@cloistr/ui/components'
import '@cloistr/ui/styles'
import { registerSW } from 'virtual:pwa-register'
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

// Answers "what is this browser actually running?" without a screenshot.
declare const __CLOISTR_BUILD__: string
;(window as unknown as { __CLOISTR_BUILD__: string }).__CLOISTR_BUILD__ = __CLOISTR_BUILD__

// Take a new deploy on the NEXT load, and reload the open tab when it lands.
//
// WHY THIS EXISTS
//
// stash is the only app in the fleet that registers a service worker, and its
// Workbox precache includes index.html behind a navigation fallback. So every
// navigation is answered from the cache, and a deploy does not reach a returning
// visitor until a later load — an open tab can sit on a months-old shell forever.
//
// Measured 2026-08-25: the operator's phone showed the pre-fix chrome — the
// hamburger centred BELOW the header, an uncollapsible desktop rail, and the
// extension promoted ahead of the signer session — several hours after the
// build carrying all three fixes was verified serving. The bundle at
// stash.cloistr.xyz contained the fixes; their service worker was handing them
// the old one.
//
// `immediate: true` registers without waiting for window load. The reload on
// controllerchange is what swaps the shell the user is already looking at.
//
// Two guards, both deliberate:
//   - `hadController` — on a FIRST visit the worker claims a page that had no
//     controller, and reloading there would bounce every new user for nothing.
//     Only an actual takeover from a previous worker triggers the reload.
//   - `reloading` — one reload, never a loop, if the worker claims again.
const hadController = 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller)

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    // A tab left open for a day never re-checks on its own: registration happens
    // once, at load. Re-check when the tab returns to the foreground, which on a
    // phone is every time the user comes back to it.
    if (!registration) return
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update()
    })
  },
})

if ('serviceWorker' in navigator) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return
    reloading = true
    window.location.reload()
  })
}

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
