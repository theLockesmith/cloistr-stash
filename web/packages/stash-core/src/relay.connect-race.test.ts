// Found live 2026-10-27: right after sign-in the console showed
// "loadFolderTree: Failed - Not connected to relay". The folder tree and the
// file list load at once; both saw no open socket and both called connect(),
// and the second new WebSocket replaced the first in Relay.socket. When the
// first opened, its caller sent on the second, still connecting, and threw.
// Concurrent connects must share one socket.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Relay } from './relay'

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static made: FakeSocket[] = []
  readyState = 0
  sent: unknown[][] = []
  onopen: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  constructor(public url?: string) {
    FakeSocket.made.push(this)
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {}
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

beforeEach(() => {
  FakeSocket.made = []
  vi.stubGlobal('WebSocket', FakeSocket)
  Relay.socket = null
  Relay.connected = false
  Relay.url = null
})

afterEach(() => {
  Relay.socket = null
  Relay.connected = false
  vi.unstubAllGlobals()
})

describe('concurrent relay connects', () => {
  it('share one socket, and every caller can send on it', async () => {
    const a = Relay.query([{ kinds: [30079] }])
    const b = Relay.query([{ kinds: [30078] }])
    await Promise.resolve()
    expect(FakeSocket.made.length).toBe(1)

    FakeSocket.made[0].open()
    await vi.waitFor(() => expect(FakeSocket.made[0].sent.filter((m) => m[0] === 'REQ').length).toBe(2))
    for (const req of FakeSocket.made[0].sent.filter((m) => m[0] === 'REQ')) {
      Relay.handleMessage(JSON.stringify(['EOSE', req[1]]))
    }
    await expect(Promise.all([a, b])).resolves.toEqual([[], []])
  })

  it('a failed connect lets the next caller try again', async () => {
    const a = Relay.connect()
    FakeSocket.made[0].onerror?.(new Error('down'))
    await expect(a).rejects.toThrow()
    const b = Relay.connect()
    expect(FakeSocket.made.length).toBe(2)
    FakeSocket.made[1].open()
    await expect(b).resolves.toBe(true)
  })
})
