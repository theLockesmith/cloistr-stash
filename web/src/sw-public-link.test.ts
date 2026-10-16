import { describe, it, expect } from 'vitest'
import { workboxOptions } from '../vite.config'

// Workbox's NavigationRoute answers a navigation with navigateFallback unless
// the URL's pathname + search matches a denylist entry. This mirrors that check.
function workerAnswers(url: string): boolean {
  const { pathname, search } = new URL(url, 'https://stash.cloistr.xyz')
  const path = pathname + search
  return !(workboxOptions.navigateFallbackDenylist ?? []).some((re) => re.test(path))
}

const HASH = 'a'.repeat(64)

describe('service worker never answers share links', () => {
  it('has a navigate fallback, so the denylist is what keeps /public/ out', () => {
    expect(workboxOptions.navigateFallback).toBe('/index.html')
  })

  it.each([
    `/public/${HASH}`,
    `/public/${HASH}#key`,
    `/public/${HASH}?download=1`,
    '/public/not-a-hash', // the server answers 400, not the cached app
  ])('leaves %s to the server', (url) => {
    expect(workerAnswers(url), `${url} would get cached index.html without the server's headers`).toBe(false)
  })

  it.each(['/', '/shared', '/folder/abc'])('still answers app route %s offline', (url) => {
    expect(workerAnswers(url)).toBe(true)
  })
})
