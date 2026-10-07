import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AuthSignerError,
  AUTH_TIMEOUT_MS,
  PublishTimeoutError,
  PUBLISH_TIMEOUT_MS,
} from '@cloistr/collab-common/core'
import { Relay, type RelayAuthPort, type SignedEvent } from './relay'

// Node test env has no WebSocket; Relay only reads the OPEN constant from it.
class FakeSocket {
  static OPEN = 1
  readyState = 1
  sent: unknown[][] = []
  closed = false
  onopen: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  constructor(public url?: string) {}
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.closed = true
  }
}

const event = (id: string): SignedEvent =>
  ({ id, pubkey: 'p', created_at: 1, kind: 30078, tags: [], content: '', sig: 's' }) as SignedEvent

function relayMsg(msg: unknown[]) {
  Relay.handleMessage(JSON.stringify(msg))
}

let socket: FakeSocket

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  socket = new FakeSocket()
  Relay.socket = socket as unknown as WebSocket
  Relay.connected = true
  Relay.url = 'wss://relay.test'
  Relay.pendingPublishes.clear()
  Relay.pendingAuthRetry.clear()
  Relay.configure({ auth: null })
})

afterEach(() => {
  Relay.socket = null
  Relay.connected = false
  Relay.authenticated = false
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Publish, then have the relay answer auth-required so the event parks in pendingAuthRetry. */
async function publishNeedingAuth(id: string) {
  const p = Relay.publish(event(id))
  const settled = p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  )
  relayMsg(['OK', id, false, 'auth-required: please authenticate'])
  return settled
}

describe('Relay publish is bounded', () => {
  it('rejects with PublishTimeoutError at PUBLISH_TIMEOUT_MS when the relay never answers', async () => {
    const p = Relay.publish(event('e1'))
    let result: unknown = 'pending'
    p.catch((e) => (result = e))

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - 1)
    expect(result).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeInstanceOf(PublishTimeoutError)
    expect(Relay.pendingPublishes.size).toBe(0)
  })

  it('times out an event parked for auth and removes it from the retry queue', async () => {
    const settled = publishNeedingAuth('e2')
    expect(Relay.pendingAuthRetry.has('e2')).toBe(true)

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS)
    const r = await settled
    expect(r.ok).toBe(false)
    expect((r as { e: Error }).e).toBeInstanceOf(PublishTimeoutError)
    expect(Relay.pendingAuthRetry.size).toBe(0)
  })
})

describe('Relay NIP-42 auth is bounded', () => {
  it('fails queued publishes with AuthSignerError at AUTH_TIMEOUT_MS when the signer never answers', async () => {
    const auth: RelayAuthPort = { isConnected: true, signEvent: () => new Promise(() => {}) }
    Relay.configure({ auth })

    const settled = publishNeedingAuth('e3')
    relayMsg(['AUTH', 'challenge-1'])

    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS)
    const r = await settled
    expect(r.ok).toBe(false)
    expect((r as { e: Error }).e).toBeInstanceOf(AuthSignerError)
    expect(Relay.pendingAuthRetry.size).toBe(0)
    expect(Relay.authenticated).toBe(false)
    expect(socket.sent.some((m) => m[0] === 'AUTH')).toBe(false)
  })

  it('fails queued publishes at once when the signer refuses', async () => {
    const auth: RelayAuthPort = {
      isConnected: true,
      signEvent: () => Promise.reject(new Error('user rejected')),
    }
    Relay.configure({ auth })

    const settled = publishNeedingAuth('e4')
    relayMsg(['AUTH', 'challenge-2'])

    await vi.advanceTimersByTimeAsync(0)
    const r = await settled
    expect(r.ok).toBe(false)
    expect((r as { e: Error }).e).toBeInstanceOf(AuthSignerError)
    expect((r as { e: Error }).e.message).toContain('user rejected')
  })

  it('fails queued publishes when a challenge arrives with no signer connected', async () => {
    const settled = publishNeedingAuth('e5')
    relayMsg(['AUTH', 'challenge-3'])

    await vi.advanceTimersByTimeAsync(0)
    const r = await settled
    expect(r.ok).toBe(false)
    expect((r as { e: Error }).e).toBeInstanceOf(AuthSignerError)
  })

  it('still authenticates and retries when the signer answers in time', async () => {
    const auth: RelayAuthPort = {
      isConnected: true,
      signEvent: async (e) => ({ ...e, id: 'auth', pubkey: 'p', sig: 's' }) as SignedEvent,
    }
    Relay.configure({ auth })

    const settled = publishNeedingAuth('e6')
    relayMsg(['AUTH', 'challenge-4'])
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.sent.filter((m) => m[0] === 'AUTH')).toHaveLength(1)
    expect(socket.sent.filter((m) => m[0] === 'EVENT')).toHaveLength(2) // original + retry
    relayMsg(['OK', 'e6', true, ''])

    const r = await settled
    expect(r.ok).toBe(true)
    // The auth timer was cleared: a second queued event survives past AUTH_TIMEOUT_MS.
    const second = publishNeedingAuth('e6b')
    let secondDone = false
    void second.then(() => (secondDone = true))
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS)
    expect(secondDone).toBe(false)
    expect(Relay.pendingAuthRetry.has('e6b')).toBe(true)
  })

  it('ignores a signer that answers after the timeout: no AUTH sent, not authenticated', async () => {
    let answer: (e: SignedEvent) => void = () => {}
    const auth: RelayAuthPort = {
      isConnected: true,
      signEvent: () => new Promise<SignedEvent>((res) => (answer = res)),
    }
    Relay.configure({ auth })

    const settled = publishNeedingAuth('e7')
    relayMsg(['AUTH', 'challenge-5'])
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS)
    expect((await settled).ok).toBe(false)

    answer({ id: 'late', pubkey: 'p', created_at: 1, kind: 22242, tags: [], content: '', sig: 's' } as SignedEvent)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent.some((m) => m[0] === 'AUTH')).toBe(false)
    expect(Relay.authenticated).toBe(false)
  })

  it('fails every queued publish, not just one', async () => {
    const auth: RelayAuthPort = { isConnected: true, signEvent: () => new Promise(() => {}) }
    Relay.configure({ auth })

    const all = [publishNeedingAuth('m1'), publishNeedingAuth('m2'), publishNeedingAuth('m3')]
    expect(Relay.pendingAuthRetry.size).toBe(3)
    relayMsg(['AUTH', 'challenge-6'])
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS)

    for (const r of await Promise.all(all)) {
      expect(r.ok).toBe(false)
      expect((r as { e: Error }).e).toBeInstanceOf(AuthSignerError)
    }
    expect(Relay.pendingAuthRetry.size).toBe(0)
  })

  it('drops a retried event from pendingPublishes when the retry send fails', async () => {
    const auth: RelayAuthPort = {
      isConnected: true,
      signEvent: async (e) => ({ ...e, id: 'auth', pubkey: 'p', sig: 's' }) as SignedEvent,
    }
    Relay.configure({ auth })
    const settled = publishNeedingAuth('e8')
    // The AUTH frame goes out, then the socket dies before the retried EVENT.
    const realSend = socket.send.bind(socket)
    socket.send = (raw: string) => {
      if (JSON.parse(raw)[0] === 'EVENT') throw new Error('Not connected to relay')
      realSend(raw)
    }
    relayMsg(['AUTH', 'challenge-7'])
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.sent.some((m) => m[0] === 'AUTH')).toBe(true)
    expect((await settled).ok).toBe(false)
    expect(Relay.pendingPublishes.has('e8')).toBe(false)
    expect(Relay.pendingAuthRetry.has('e8')).toBe(false)
  })
})

describe('Relay disconnect', () => {
  it('fails in-flight and auth-queued publishes immediately, without waiting for the publish timer', async () => {
    const inflight = Relay.publish(event('d1')).then(
      () => 'ok',
      (e: Error) => e.message,
    )
    const queued = publishNeedingAuth('d2')
    Relay.disconnect()
    await vi.advanceTimersByTimeAsync(0)

    expect(await inflight).toMatch(/disconnect/i)
    expect((await queued).ok).toBe(false)
    expect(Relay.pendingPublishes.size).toBe(0)
    expect(Relay.pendingAuthRetry.size).toBe(0)
  })
})

describe('Relay connect timeout', () => {
  it('closes the half-open socket when the connection times out', async () => {
    Relay.socket = null
    Relay.connected = false
    const p = Relay.connect('wss://relay.test')
    p.catch(() => {})
    const opened = Relay.socket as unknown as FakeSocket

    await vi.advanceTimersByTimeAsync(10000)
    await expect(p).rejects.toThrow('Connection timeout')
    expect(opened.closed).toBe(true)
    expect(Relay.socket).toBeNull()
  })
})
