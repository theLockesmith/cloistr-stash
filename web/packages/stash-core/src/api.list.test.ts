// GET /api/files lists only the caller's own files (2026-10-15). A signer
// session cookie travels with the plain request; without one the server says
// 401 and the client signs NIP-98 for the exact URL, then keeps signing.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { API } from './api'

const ME = 'a'.repeat(64)

beforeEach(() => {
  API.ownReadsNeedSignature = false
  API.httpAuth = vi.fn(async (url: string, method: string) => `Nostr signed:${method}:${url}`)
})
afterEach(() => {
  vi.unstubAllGlobals()
  API.httpAuth = null
})

function stubFetch(statuses: number[]) {
  const calls: Array<{ url: string; auth: string | null }> = []
  vi.stubGlobal('window', { location: { origin: 'https://stash.example' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('Authorization') })
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]
      return { ok: status === 200, status, json: async () => ({ files: [] }) }
    }),
  )
  return calls
}

describe('own file listing', () => {
  it('signs nothing when the session cookie is accepted', async () => {
    const calls = stubFetch([200])
    await API.listFilesInFolder(ME, 'f1')
    expect(calls).toEqual([{ url: `/api/files?pubkey=${ME}&folder=f1`, auth: null }])
    expect(API.httpAuth).not.toHaveBeenCalled()
  })

  it('on 401 signs NIP-98 for the exact absolute URL and retries, then signs directly', async () => {
    const calls = stubFetch([401, 200, 200])
    await API.listFiles(ME)
    expect(calls[1].auth).toBe(`Nostr signed:GET:https://stash.example/api/files?pubkey=${ME}`)
    await API.listFilesInFolder(ME, '')
    expect(calls).toHaveLength(3)
    expect(calls[2].auth).toBe(`Nostr signed:GET:https://stash.example/api/files?pubkey=${ME}&folder=`)
  })

  it('surfaces the 401 when no signer is wired', async () => {
    API.httpAuth = null
    stubFetch([401])
    await expect(API.listFiles(ME)).rejects.toThrow(/401/)
  })
})
