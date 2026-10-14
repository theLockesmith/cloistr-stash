// Service worker registration that moves open pages onto a new release
// without ever reloading under the user.
//
// Self-contained on purpose: no React, no app imports, so other Cloistr apps
// can lift it as-is.
//
// The worker is built with skipWaiting + clientsClaim, so a new release takes
// control of every open tab as soon as it installs. The page has to follow:
// before this, the generated registerSW.js only called register(). A tab kept
// running the old bundle, and a reload was answered from the old precache while
// the update downloaded, so a release took two reloads to show, or never for a
// tab left open. Seen live 2026-10-14: a signed-in tab still showed the retired
// Docs/Sheets/Slides/Whiteboard menu two days after @cloistr/ui 0.48 shipped.
//
// Behaviour:
// - check for a release on load, whenever the tab becomes visible, and hourly
// - a release that takes over within FRESH_LOAD_WINDOW_MS of load, while the
//   page is not busy, reloads straight onto it
// - otherwise (a long-open tab, or an upload or unsaved edit in progress) it
//   never reloads; onUpdateReady fires so the app can show a persistent notice
// - on a first visit the first takeover is the install claiming the page, not
//   a release; later takeovers are releases and are handled as above

/** A new worker taking over this soon after load may reload without asking. */
export const FRESH_LOAD_WINDOW_MS = 15_000
/** How often an open tab asks for a new release. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Busy tracking: the page must not reload while any of these are true.

const busyHolders = new Set<symbol>()

/** Marks the page busy until the returned release function is called. */
export function holdBusy(): () => void {
  const token = Symbol('busy')
  busyHolders.add(token)
  return () => {
    busyHolders.delete(token)
  }
}

/** Runs fn with the page marked busy for its whole duration. */
export async function whileBusy<T>(fn: () => Promise<T>): Promise<T> {
  const release = holdBusy()
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Wraps an async action so the page counts as busy for its whole duration,
 * every awaited step included, and is released even if it throws.
 */
export function busyWhileRunning<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => whileBusy(() => fn(...args))
}

/** True while any holdBusy() is outstanding. */
export function hasBusyHolders(): boolean {
  return busyHolders.size > 0
}

/** The parts of a Document hasUnsavedInput reads. */
export interface InputScanRoot {
  querySelectorAll(selectors: string): ArrayLike<unknown>
}

const TEXT_LIKE = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=number], input[type=password]'

/**
 * True when a form field holds an edit the user has not saved (its value
 * differs from the value it was rendered with), or a rich-text editor is open.
 */
export function hasUnsavedInput(root: InputScanRoot): boolean {
  const fields = root.querySelectorAll(TEXT_LIKE)
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as { value?: string; defaultValue?: string }
    if ((f.value ?? '') !== (f.defaultValue ?? '')) return true
  }
  return root.querySelectorAll('[contenteditable=""], [contenteditable="true"]').length > 0
}

// ---------------------------------------------------------------------------

export interface PwaDeps {
  serviceWorker: Pick<ServiceWorkerContainer, 'controller' | 'register' | 'addEventListener'>
  now: () => number
  reload: () => void
  isOnline: () => boolean
  /** Upload in flight or unsaved edit on the page. */
  isBusy: () => boolean
  onVisible: (fn: () => void) => void
  every: (ms: number, fn: () => void) => void
}

/**
 * Registers /sw.js and wires update handling. onUpdateReady fires when a new
 * release took control and the page was not reloaded onto it; it may fire more
 * than once (one per release), so the notice it shows must be idempotent.
 */
export async function registerServiceWorker(
  onUpdateReady: () => void,
  deps: PwaDeps,
): Promise<void> {
  const loadedAt = deps.now()
  // With no controller, the first controllerchange is clientsClaim taking a
  // page that already runs the current bundle. Only that one is skipped.
  let skipNext = deps.serviceWorker.controller === null

  deps.serviceWorker.addEventListener('controllerchange', () => {
    if (skipNext) {
      skipNext = false
      return
    }
    if (deps.now() - loadedAt < FRESH_LOAD_WINDOW_MS && !deps.isBusy()) {
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
    isBusy: () => hasBusyHolders() || hasUnsavedInput(document),
    onVisible: (fn) =>
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') fn()
      }),
    every: (ms, fn) => {
      setInterval(fn, ms)
    },
  }
}
