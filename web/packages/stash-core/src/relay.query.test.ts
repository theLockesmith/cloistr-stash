// One REQ can carry several filters (NIP-01). A shared-folder listing sends
// its #q filter and its ring #d filter together, as a single relay query.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Relay, type SignedEvent } from './relay'

class FakeSocket {
  static OPEN = 1
  readyState = 1
  sent: unknown[][] = []
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {}
}

let socket: FakeSocket

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  socket = new FakeSocket()
  Relay.socket = socket as unknown as WebSocket
  Relay.connected = true
  Relay.url = 'wss://relay.test'
})

afterEach(() => {
  Relay.socket = null
  Relay.connected = false
  vi.unstubAllGlobals()
})

describe('Relay.query', () => {
  it('sends every filter in one REQ and resolves with the events up to EOSE', async () => {
    const filters = [{ kinds: [30078], '#q': ['q1'] }, { kinds: [30079], '#d': ['r1'] }]
    const p = Relay.query(filters)
    expect(socket.sent).toHaveLength(1)
    const [verb, subId, ...sentFilters] = socket.sent[0] as [string, string, ...unknown[]]
    expect(verb).toBe('REQ')
    expect(sentFilters).toEqual(filters)
    const ev = { id: 'e1', pubkey: 'p', created_at: 1, kind: 30078, tags: [], content: '', sig: '' } as SignedEvent
    Relay.handleMessage(JSON.stringify(['EVENT', subId, ev]))
    Relay.handleMessage(JSON.stringify(['EOSE', subId]))
    expect(await p).toEqual([ev])
  })

  it('refuses an empty filter list instead of sending a REQ with none', async () => {
    await expect(Relay.query([])).rejects.toThrow(/filter/)
    expect(socket.sent).toHaveLength(0)
  })
})
