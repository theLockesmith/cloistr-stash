import { describe, expect, it, vi } from 'vitest'
import {
  FRESH_LOAD_WINDOW_MS,
  UPDATE_CHECK_INTERVAL_MS,
  hasBusyHolders,
  hasUnsavedInput,
  holdBusy,
  registerServiceWorker,
  whileBusy,
  type PwaDeps,
} from './pwaUpdate'

function fakeDeps(opts: { controller: boolean; busy?: () => boolean }) {
  let t = 1_000
  const listeners: Array<() => void> = []
  const update = vi.fn(() => Promise.resolve())
  const visible: Array<() => void> = []
  const intervals: Array<[number, () => void]> = []
  const deps: PwaDeps = {
    serviceWorker: {
      controller: opts.controller ? ({} as ServiceWorker) : null,
      register: vi.fn(() => Promise.resolve({ update } as unknown as ServiceWorkerRegistration)),
      addEventListener: ((type: string, fn: () => void) => {
        if (type === 'controllerchange') listeners.push(fn)
      }) as ServiceWorkerContainer['addEventListener'],
    },
    now: () => t,
    reload: vi.fn(),
    isOnline: () => true,
    isBusy: opts.busy ?? (() => false),
    onVisible: (fn) => visible.push(fn),
    every: (ms, fn) => intervals.push([ms, fn]),
  }
  return {
    deps,
    update,
    advance: (ms: number) => (t += ms),
    takeOver: () => listeners.forEach((fn) => fn()),
    visible,
    intervals,
  }
}

describe('registerServiceWorker', () => {
  it('reloads onto a release that takes over right after load', async () => {
    const f = fakeDeps({ controller: true })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.advance(FRESH_LOAD_WINDOW_MS - 1)
    f.takeOver()
    expect(f.deps.reload).toHaveBeenCalledTimes(1)
    expect(ready).not.toHaveBeenCalled()
  })

  it('never reloads a busy page, even right after load; shows the notice', async () => {
    let busy = true
    const f = fakeDeps({ controller: true, busy: () => busy })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.takeOver()
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledTimes(1)
    busy = false
  })

  it('does not reload a long-open tab; notifies on every release', async () => {
    const f = fakeDeps({ controller: true })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.advance(FRESH_LOAD_WINDOW_MS + 1)
    f.takeOver()
    f.takeOver()
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledTimes(2)
  })

  it('first visit: skips the install claim, still catches a later release', async () => {
    const f = fakeDeps({ controller: false })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.takeOver() // install claiming the page
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    f.advance(FRESH_LOAD_WINDOW_MS + 1)
    f.takeOver() // a real release, much later
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('checks for a release when the tab becomes visible and hourly', async () => {
    const f = fakeDeps({ controller: true })
    await registerServiceWorker(() => {}, f.deps)
    expect(f.deps.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    expect(f.intervals).toHaveLength(1)
    expect(f.intervals[0][0]).toBe(UPDATE_CHECK_INTERVAL_MS)
    f.visible[0]()
    f.intervals[0][1]()
    expect(f.update).toHaveBeenCalledTimes(2)
  })
})

describe('busy tracking', () => {
  it('whileBusy holds busy for the whole call and releases on failure', async () => {
    let seen = false
    await whileBusy(async () => {
      seen = hasBusyHolders()
    })
    expect(seen).toBe(true)
    expect(hasBusyHolders()).toBe(false)
    await expect(
      whileBusy(async () => {
        throw new Error('upload failed')
      }),
    ).rejects.toThrow('upload failed')
    expect(hasBusyHolders()).toBe(false)
  })

  it('holdBusy holders are independent', () => {
    const a = holdBusy()
    const b = holdBusy()
    a()
    expect(hasBusyHolders()).toBe(true)
    b()
    expect(hasBusyHolders()).toBe(false)
  })

  const root = (fields: Array<{ value: string; defaultValue: string }>, editors = 0) => ({
    querySelectorAll: (sel: string) => (sel.includes('contenteditable') ? new Array(editors).fill({}) : fields),
  })

  it('hasUnsavedInput: an edited field or an open editor counts, an untouched form does not', () => {
    expect(hasUnsavedInput(root([{ value: 'report.pdf', defaultValue: 'report.pdf' }]))).toBe(false)
    expect(hasUnsavedInput(root([{ value: 'report-v2.pdf', defaultValue: 'report.pdf' }]))).toBe(true)
    expect(hasUnsavedInput(root([], 1))).toBe(true)
  })
})
