import { describe, expect, it, vi } from 'vitest'
import { FRESH_LOAD_WINDOW_MS, UPDATE_CHECK_INTERVAL_MS, registerServiceWorker, type PwaDeps } from './pwaUpdate'

function fakeDeps(opts: { controller: boolean }) {
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
  it('reloads onto a new release that takes over right after load', async () => {
    const f = fakeDeps({ controller: true })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.advance(FRESH_LOAD_WINDOW_MS - 1)
    f.takeOver()
    expect(f.deps.reload).toHaveBeenCalledTimes(1)
    expect(ready).not.toHaveBeenCalled()
  })

  it('does not reload a long-open tab; tells the user once', async () => {
    const f = fakeDeps({ controller: true })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.advance(FRESH_LOAD_WINDOW_MS + 1)
    f.takeOver()
    f.takeOver()
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('does nothing on the first install (no previous worker)', async () => {
    const f = fakeDeps({ controller: false })
    const ready = vi.fn()
    await registerServiceWorker(ready, f.deps)
    f.takeOver()
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
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
