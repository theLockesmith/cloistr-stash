// Found live 2026-10-27 (key-model proof): an upload on the remote (NIP-46)
// signer was reported FAILED with PublishTimeoutError while its record had
// landed on the relay. The relay asks for NIP-42 auth first; signing that auth
// over NIP-46 used most of the 15s publish budget, so the re-sent event's OK
// came after the timer had fired. The user then retries and gets a duplicate.
// A re-send after auth gets its own round trip (the auth wait is bounded by
// AUTH_TIMEOUT_MS), and a timeout asks the relay before reporting a failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AUTH_TIMEOUT_MS, PublishTimeoutError, PUBLISH_TIMEOUT_MS } from '@cloistr/collab-common/core'
import { Relay, PUBLISH_VERIFY_TIMEOUT_MS, type RelayAuthPort, type SignedEvent } from './relay'

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


const settle = <T,>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  )

/** The REQ the relay sent last, as [subId, filter]. */
const lastReq = () => {
  const req = [...socket.sent].reverse().find((m) => m[0] === 'REQ')
  return req ? (req.slice(1) as [string, Record<string, unknown>]) : null
}

describe('a publish that needs NIP-42 auth on a slow signer', () => {
  it('gets a fresh round trip after auth, so a late OK still succeeds', async () => {
    let signAuth!: (e: SignedEvent) => void
    const auth: RelayAuthPort = { isConnected: true, signEvent: () => new Promise((r) => (signAuth = r)) }
    Relay.configure({ auth })

    const settled = settle(Relay.publish(event('slow1')))
    relayMsg(['OK', 'slow1', false, 'auth-required: please authenticate'])
    relayMsg(['AUTH', 'challenge-slow'])

    // The signer takes most of the auth budget (well within AUTH_TIMEOUT_MS)...
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS - 1000)
    signAuth(event('auth-ev'))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent.filter((m) => m[0] === 'EVENT').length).toBe(2)

    // ...and the relay answers the re-sent event later than 15s after the first send.
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - 1000)
    relayMsg(['OK', 'slow1', true, ''])
    const r = await settled
    expect(r.ok).toBe(true)
  })
})

describe('a publish whose OK never arrives', () => {
  it('succeeds when the relay holds the event', async () => {
    const settled = settle(Relay.publish(event('landed1')))
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS)

    const req = lastReq()
    expect(req?.[1]).toEqual({ ids: ['landed1'] })
    relayMsg(['EVENT', req![0], event('landed1')])
    relayMsg(['EOSE', req![0]])

    const r = await settled
    expect(r.ok).toBe(true)
    expect(Relay.pendingPublishes.size).toBe(0)
  })

  it('fails with PublishTimeoutError when the relay does not hold it', async () => {
    const settled = settle(Relay.publish(event('lost1')))
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS)
    const req = lastReq()
    relayMsg(['EOSE', req![0]])

    const r = await settled
    expect(r.ok).toBe(false)
    expect((r as { e: Error }).e).toBeInstanceOf(PublishTimeoutError)
    expect(Relay.pendingPublishes.size).toBe(0)
  })

  it('fails with PublishTimeoutError when the check itself gets no answer', async () => {
    const settled = settle(Relay.publish(event('lost2')))
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS + PUBLISH_VERIFY_TIMEOUT_MS)
    const r = await settled
    expect(r.ok).toBe(false)
    expect((r as { e: Error }).e).toBeInstanceOf(PublishTimeoutError)
  })
})
