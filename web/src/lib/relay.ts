// Relay module for direct WebSocket connection to a Nostr relay.
// Used for NIP-07 users who need to publish events directly.
//
// PORTED VERBATIM from legacy/js/relay.js — same connection lifecycle,
// message handling (OK/AUTH/NOTICE/EOSE/EVENT), NIP-42 auth (kind 22242),
// publish-with-auth-retry, and subscribe semantics. The global `Auth`
// singleton is injected via configure() as a typed RelayAuthPort.

import type { SignedEvent } from './api'

// Re-export so the data-layer modules can source both event types from './relay'.
export type { SignedEvent } from './api'

/** Auth surface the relay needs (provided by the auth layer). */
export interface RelayAuthPort {
  readonly isConnected: boolean
  signEvent(event: UnsignedEvent): Promise<SignedEvent>
}

export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export type NostrFilter = Record<string, unknown>

interface PendingPublish {
  event: SignedEvent
  timeout: ReturnType<typeof setTimeout>
  resolve: (result: { success: boolean; message?: string }) => void
  reject: (err: Error) => void
}

interface PendingSubscription {
  events: SignedEvent[]
  resolve: (events: SignedEvent[]) => void
  reject: (err: Error) => void
}

export const Relay = {
  defaultUrl: 'wss://relay.cloistr.xyz',

  socket: null as WebSocket | null,
  url: null as string | null,

  connected: false,
  authenticated: false,

  pendingPublishes: new Map<string, PendingPublish>(),
  pendingAuthRetry: new Map<string, PendingPublish>(),
  pendingSubscriptions: new Map<string, PendingSubscription>(),

  auth: null as RelayAuthPort | null,

  configure(deps: { auth?: RelayAuthPort | null }): void {
    if (deps.auth !== undefined) this.auth = deps.auth
  },

  async connect(url: string | null = null): Promise<boolean> {
    this.url = url || this.defaultUrl

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return true
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'))
      }, 10000)

      try {
        this.socket = new WebSocket(this.url!)

        this.socket.onopen = () => {
          clearTimeout(timeout)
          this.connected = true
          console.log('Relay: Connected to', this.url)
          resolve(true)
        }

        this.socket.onerror = (err) => {
          clearTimeout(timeout)
          console.error('Relay: Connection error:', err)
          reject(new Error('Failed to connect to relay'))
        }

        this.socket.onclose = () => {
          this.connected = false
          this.authenticated = false
          console.log('Relay: Disconnected')
        }

        this.socket.onmessage = (msg) => {
          this.handleMessage(msg.data)
        }
      } catch (err) {
        clearTimeout(timeout)
        reject(err as Error)
      }
    })
  },

  handleMessage(data: string): void {
    try {
      const message = JSON.parse(data)
      const type = message[0]

      switch (type) {
        case 'OK': {
          // ["OK", event_id, success, message]
          const [, eventId, success, okMessage] = message
          const pending = this.pendingPublishes.get(eventId)
          if (pending) {
            if (success) {
              pending.resolve({ success: true, message: okMessage })
              this.pendingPublishes.delete(eventId)
            } else if (okMessage && okMessage.includes('auth')) {
              console.log(
                'Relay: Auth required for event',
                eventId.slice(0, 8) + '..., queueing for retry',
              )
              this.pendingAuthRetry.set(eventId, pending)
              this.pendingPublishes.delete(eventId)
              // Note: don't reject - wait for auth and retry
            } else {
              pending.reject(new Error(okMessage || 'Publish rejected'))
              this.pendingPublishes.delete(eventId)
            }
          }
          break
        }

        case 'AUTH': {
          // NIP-42 challenge: ["AUTH", challenge]
          const challenge = message[1]
          this.handleAuthChallenge(challenge)
          break
        }

        case 'NOTICE':
          console.log('Relay notice:', message[1])
          break

        case 'EOSE': {
          // ["EOSE", subscription_id]
          const eoseSubId = message[1]
          const eoseSub = this.pendingSubscriptions.get(eoseSubId)
          if (eoseSub) {
            eoseSub.resolve(eoseSub.events)
            this.pendingSubscriptions.delete(eoseSubId)
            this.send(['CLOSE', eoseSubId])
          }
          break
        }

        case 'EVENT': {
          // ["EVENT", subscription_id, event]
          const eventSubId = message[1]
          const event = message[2]
          const eventSub = this.pendingSubscriptions.get(eventSubId)
          if (eventSub) {
            eventSub.events.push(event)
          }
          break
        }

        default:
          console.log('Relay: Unknown message type:', type)
      }
    } catch (err) {
      console.error('Relay: Failed to parse message:', err)
    }
  },

  async handleAuthChallenge(challenge: string): Promise<void> {
    if (!this.auth || !this.auth.isConnected) {
      console.warn('Relay: Auth challenge received but not connected to signer')
      return
    }

    try {
      console.log('Relay: Responding to NIP-42 auth challenge')

      const now = Math.floor(Date.now() / 1000)
      const authEvent: UnsignedEvent = {
        kind: 22242,
        created_at: now,
        tags: [
          ['relay', this.url!],
          ['challenge', challenge],
        ],
        content: '',
      }

      const signedAuth = await this.auth.signEvent(authEvent)

      this.send(['AUTH', signedAuth])
      this.authenticated = true
      console.log('Relay: NIP-42 authentication sent')

      await this.retryPendingAfterAuth()
    } catch (err) {
      console.error('Relay: Failed to handle auth challenge:', err)
    }
  },

  async retryPendingAfterAuth(): Promise<void> {
    if (this.pendingAuthRetry.size === 0) {
      return
    }

    console.log('Relay: Retrying', this.pendingAuthRetry.size, 'events after auth')

    for (const [eventId, pending] of this.pendingAuthRetry) {
      try {
        this.pendingPublishes.set(eventId, pending)
        this.pendingAuthRetry.delete(eventId)

        this.send(['EVENT', pending.event])
        console.log('Relay: Retried event', eventId.slice(0, 8) + '...')
      } catch (err) {
        console.error('Relay: Failed to retry event', eventId.slice(0, 8) + '...:', err)
        pending.reject(err as Error)
        this.pendingAuthRetry.delete(eventId)
      }
    }
  },

  send(message: unknown[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to relay')
    }
    this.socket.send(JSON.stringify(message))
  },

  async publish(signedEvent: SignedEvent): Promise<{ success: boolean; message?: string }> {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.log(
        'Relay: Reconnecting before publish (connected:',
        this.connected,
        'readyState:',
        this.socket?.readyState,
        ')',
      )
      await this.connect()
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPublishes.delete(signedEvent.id)
        reject(new Error('Publish timeout'))
      }, 10000)

      this.pendingPublishes.set(signedEvent.id, {
        event: signedEvent,
        timeout,
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      })

      try {
        this.send(['EVENT', signedEvent])
        console.log('Relay: Published event', signedEvent.id.slice(0, 8) + '...')
      } catch (err) {
        clearTimeout(timeout)
        this.pendingPublishes.delete(signedEvent.id)
        reject(err as Error)
      }
    })
  },

  async subscribe(filter: NostrFilter, timeout = 10000): Promise<SignedEvent[]> {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connect()
    }

    const subId = 'sub-' + Math.random().toString(36).slice(2, 10)

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingSubscriptions.delete(subId)
        this.send(['CLOSE', subId])
        reject(new Error('Subscription timeout'))
      }, timeout)

      this.pendingSubscriptions.set(subId, {
        events: [],
        resolve: (events) => {
          clearTimeout(timeoutId)
          resolve(events)
        },
        reject: (err) => {
          clearTimeout(timeoutId)
          reject(err)
        },
      })

      this.send(['REQ', subId, filter])
    })
  },

  disconnect(): void {
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
    this.connected = false
    this.authenticated = false
    this.pendingPublishes.clear()
    this.pendingAuthRetry.clear()
  },

  isConnected(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN
  },
}

export type RelayModule = typeof Relay
export default Relay
