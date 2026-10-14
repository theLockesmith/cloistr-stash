// Service worker registration that actually moves open pages onto a new
// release.
//
// The worker itself is built with skipWaiting + clientsClaim (VitePWA
// 'autoUpdate'), so a new release takes control of every open tab as soon as
// it installs. What was missing is the page side: the generated registerSW.js
// only called register(). The page that loaded from the OLD precache kept
// running the old bundle, and a reload was answered from that cache while the
// update downloaded, so it took two reloads, or never for a tab left open, to
// see a release. Seen live 2026-10-14: a signed-in tab still showed the retired
// Docs/Sheets/Slides/Whiteboard menu two days after @cloistr/ui 0.48 shipped.
//
// Now: check for an update on load, whenever the tab becomes visible, and
// hourly. When a new worker takes control within the first seconds after load
// (before anyone can start an upload), reload straight onto it. Later, never
// reload under the user (an upload in progress would be lost); tell them.

/** A new worker taking over this soon after load reloads without asking. */
export const FRESH_LOAD_WINDOW_MS = 15_000
/** How often an open tab asks for a new release. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export interface PwaDeps {
  serviceWorker: Pick<ServiceWorkerContainer, 'controller' | 'register' | 'addEventListener'>
  now: () => number
  reload: () => void
  isOnline: () => boolean
  onVisible: (fn: () => void) => void
  every: (ms: number, fn: () => void) => void
}

/**
 * Registers /sw.js and wires update handling. onUpdateReady fires (once) when a
 * new release took control of a page that has been open too long to reload
 * automatically.
 */
export async function registerServiceWorker(
  onUpdateReady: () => void,
  deps: PwaDeps,
): Promise<void> {
  const loadedAt = deps.now()
  // With no controller this is the first install: clientsClaim fires
  // controllerchange, but the page already runs the current bundle.
  const hadController = deps.serviceWorker.controller !== null
  let handled = false

  deps.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || handled) return
    handled = true
    if (deps.now() - loadedAt < FRESH_LOAD_WINDOW_MS) {
      deps.reload()
    } else {
      onUpdateReady()
    }
  })

  const reg = await deps.serviceWorker.register('/sw.js', { scope: '/' })
  const check = () => {
    if (deps.isOnline()) reg.update().catch(() => {})
  }
  deps.onVisible(check)
  deps.every(UPDATE_CHECK_INTERVAL_MS, check)
}

/** Browser wiring for registerServiceWorker. */
export function browserPwaDeps(): PwaDeps | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  return {
    serviceWorker: navigator.serviceWorker,
    now: () => Date.now(),
    reload: () => window.location.reload(),
    isOnline: () => navigator.onLine,
    onVisible: (fn) =>
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') fn()
      }),
    every: (ms, fn) => {
      setInterval(fn, ms)
    },
  }
}
