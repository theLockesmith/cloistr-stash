// The multipart filename of an upload reaches the Stash server. Older-format
// uploads named the blob after the real file, so every path sends a fixed name.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { API } from './api'

afterEach(() => vi.unstubAllGlobals())

function sentFileName(): Promise<string> {
  return new Promise((resolve) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        resolve(((init?.body as FormData).get('file') as File).name)
        return { ok: true, status: 200, json: async () => ({ sha256: 'h' }) }
      }),
    )
  })
}

describe('API.uploadFile', () => {
  it('never sends the real file name', async () => {
    const name = sentFileName()
    await API.uploadFile(new File(['x'], 'tax-return-2026.pdf.encrypted'), 'Nostr x')
    expect(await name).toBe('blob')
  })

  it('sends the same fixed name for a nameless Blob', async () => {
    const name = sentFileName()
    await API.uploadFile(new Blob(['x']), 'Nostr x')
    expect(await name).toBe('blob')
  })
})
