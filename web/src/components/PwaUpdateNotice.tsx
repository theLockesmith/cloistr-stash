import { useEffect, useState } from 'react'
import { browserPwaDeps, registerServiceWorker } from '../pwaUpdate'

// Module-level so StrictMode's double effect run registers once.
let started = false

/**
 * Registers the service worker and, when a release could not be applied by
 * reloading (long-open tab, or busy), shows a banner that stays until the page
 * reloads. Dismissing it hides it only until the tab is next shown.
 */
export function PwaUpdateNotice() {
  const [ready, setReady] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const deps = browserPwaDeps()
    if (started || !deps) return
    started = true
    registerServiceWorker(() => {
      setReady(true)
      setHidden(false)
    }, deps).catch((err) => console.warn('service worker registration failed', err))
  }, [])

  useEffect(() => {
    if (!ready) return
    const onVis = () => {
      if (document.visibilityState === 'visible') setHidden(false)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [ready])

  if (!ready || hidden) return null
  return (
    <div className="stash-update-banner" role="status">
      <span>A new version of Stash is available. Reload when you are not in the middle of an upload.</span>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
      <button type="button" aria-label="Dismiss" onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  )
}
