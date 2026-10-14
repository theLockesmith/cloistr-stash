import { useEffect } from 'react'
import { useToast } from '@cloistr/ui/components'
import { browserPwaDeps, registerServiceWorker } from '../pwaUpdate'

// Module-level so StrictMode's double effect run registers once.
let started = false

/** Registers the service worker; tells a long-open tab a new release is in. */
export function PwaUpdateNotice() {
  const { info } = useToast()
  useEffect(() => {
    const deps = browserPwaDeps()
    if (started || !deps) return
    started = true
    registerServiceWorker(
      () => info('A new version of Stash is available. Reload the page to update.', { duration: 0 }),
      deps,
    ).catch((err) => console.warn('service worker registration failed', err))
  }, [info])
  return null
}
