// GET /api/quota now returns per-user numbers only to their owner, via NIP-98.
// The app asks unsigned first and signs only when quota is enabled, so a
// remote-signer user pays no signing round trip while quota is off.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { API } from './api'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(responses: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; auth: string | null }> = []
  vi.stubGlobal('window', { location: { origin: 'https://stash.example' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      calls.push({ url, auth: h.get('Authorization') })
      const body = responses[Math.min(calls.length - 1, responses.length - 1)]
      return { ok: true, status: 200, json: async () => body }
    }),
  )
  return calls
}

describe('API.getQuota', () => {
  it('does not sign anything while quota is disabled', async () => {
    const calls = stubFetch([{ enabled: false }])
    const sign = vi.fn(async () => 'Nostr x')
    expect(await API.getQuota(sign)).toEqual({ enabled: false })
    expect(sign).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).not.toContain('pubkey=')
  })

  it('fetches its own usage with a NIP-98 header for the exact URL when enabled', async () => {
    const calls = stubFetch([{ enabled: true }, { enabled: true, used: 4096 }])
    const sign = vi.fn(async (url: string, method: string) => `Nostr signed:${method}:${url}`)
    expect(await API.getQuota(sign)).toEqual({ enabled: true, used: 4096 })
    expect(sign).toHaveBeenCalledWith('https://stash.example/api/quota', 'GET')
    expect(calls).toHaveLength(2)
    expect(calls[1].auth).toBe('Nostr signed:GET:https://stash.example/api/quota')
    expect(calls.every((c) => !c.url.includes('pubkey='))).toBe(true)
  })
})
