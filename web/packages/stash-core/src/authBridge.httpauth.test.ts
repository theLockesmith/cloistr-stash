// cloistr-pr 2026-10-16 on !191: createHttpAuth signed only u and method, so
// two requests for the same URL in the same second got the same event id and
// the server's one-use cache refused the second ("Failed to list files: 401").
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./migration-wrapped-keys', () => ({ runWrappedKeyMigration: async () => null }))

import { authPort, updateAuth, type Signer } from './authBridge'
import { Keys } from './keys'
import type { UnsignedEvent, SignedEvent } from './relay'

const PK = 'a'.repeat(64)

// The NIP-01 id is all the replay cache keys on, so compute it for real.
const signer: Signer = {
  getPublicKey: async () => PK,
  signEvent: async (ev: UnsignedEvent) => {
    const id = createHash('sha256')
      .update(JSON.stringify([0, PK, ev.created_at, ev.kind, ev.tags, ev.content]))
      .digest('hex')
    return { ...ev, pubkey: PK, id, sig: '0'.repeat(128) } as SignedEvent
  },
  encrypt: async () => '',
  decrypt: async () => '',
}

const decode = (h: string) => JSON.parse(atob(h.replace(/^Nostr /, ''))) as SignedEvent

afterEach(() => vi.useRealTimers())

describe('createHttpAuth', () => {
  it('signs the same URL twice in one second with two different event ids', async () => {
    vi.spyOn(Keys, 'init').mockImplementation(async () => {})
    await updateAuth(signer, { isConnected: true, pubkey: PK })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T12:00:00.250Z'))

    const url = 'https://stash.cloistr.xyz/api/files?pubkey=' + PK
    const a = decode(await authPort.createHttpAuth(url, 'GET'))
    vi.setSystemTime(new Date('2026-10-16T12:00:00.750Z'))
    const b = decode(await authPort.createHttpAuth(url, 'GET'))

    expect(a.created_at).toBe(b.created_at)
    expect(a.id).not.toBe(b.id)
    for (const ev of [a, b]) {
      expect(ev.kind).toBe(27235)
      expect(ev.tags).toContainEqual(['u', url])
      expect(ev.tags).toContainEqual(['method', 'GET'])
      expect(ev.tags.find((t) => t[0] === 'nonce')?.[1]).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})
