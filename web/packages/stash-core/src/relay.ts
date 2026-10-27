// Relay module for direct WebSocket connection to a Nostr relay.
// Used for NIP-07 users who need to publish events directly.
//
// PORTED VERBATIM from legacy/js/relay.js — same connection lifecycle,
// message handling (OK/AUTH/NOTICE/EOSE/EVENT), NIP-42 auth (kind 22242),
// publish-with-auth-retry, and subscribe semantics. The global `Auth`
// singleton is injected via configure() as a typed RelayAuthPort.
//
// Bounded like collab-common's boundedPublish/boundedAuth: a publish settles
// within PUBLISH_TIMEOUT_MS (PublishTimeoutError), and signing the NIP-42
// auth event within AUTH_TIMEOUT_MS. A signer that refuses or never answers
// fails every publish queued behind the auth with AuthSignerError at once,
// instead of leaving them parked until the publish timer runs out.
//
// Each send gets its own PUBLISH_TIMEOUT_MS: the wait for auth is already
// bounded by AUTH_TIMEOUT_MS, and on a NIP-46 signer it can use most of the
// budget, leaving the re-sent event too little (found live 2026-10-27). A
// sent event whose OK never comes is looked up on the relay before failing:
// a "failed" upload that in fact landed gets retried, and duplicated.

import {
  AuthSignerError,
  AUTH_TIMEOUT_MS,
  PublishTimeoutError,
  PUBLISH_TIMEOUT_MS,
} from '@cloistr/collab-common/core'
import type { SignedEvent } from './api'
import { RELAY_URL } from './serviceConfig'

/** How long a timed-out publish waits for the relay to say whether it holds the event. */
export const PUBLISH_VERIFY_TIMEOUT_MS = 5000

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
  timeout: ReturnType<typeof setTimeout> | undefined
  resolve: (result: { success: boolean; message?: string }) => void
  reject: (err: Error) => void
}

interface PendingSubscription {
  events: SignedEvent[]
  resolve: (events: SignedEvent[]) => void
  reject: (err: Error) => void
}

export const Relay = {
  defaultUrl: RELAY_URL,

  socket: null as WebSocket | null,
  // The connect in flight: callers that arrive while it opens share it, rather
  // than opening a second socket that replaces the first under its caller.
  connecting: null as Promise<boolean> | null,
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
    if (this.connecting) return this.connecting

    const attempt = new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Drop the half-open socket so a late onopen can't mark us connected.
        const stale = this.socket
        this.socket = null
        stale?.close()
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
    this.connecting = attempt.finally(() => {
      if (this.connecting === shared) this.connecting = null
    })
    const shared = this.connecting
    return shared
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
              this.armPublishTimer(pending)
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
          this.handleAuthChallenge(challenge).catch((err) =>
            console.error('Relay: Unhandled auth challenge error:', err),
          )
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
      this.failPendingAuthRetry(new AuthSignerError('no signer connected'))
      return
    }

    // What is parked now waits on a bounded signer (AUTH_TIMEOUT_MS), not on
    // the relay: its round trip starts again from here.
    for (const parked of this.pendingAuthRetry.values()) this.armPublishTimer(parked)

    let timer: ReturnType<typeof setTimeout> | undefined
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

      const signedAuth = await Promise.race([
        this.auth.signEvent(authEvent),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AuthSignerError('timed out waiting for the signer')),
            AUTH_TIMEOUT_MS,
          )
        }),
      ]).finally(() => clearTimeout(timer))

      this.send(['AUTH', signedAuth])
      this.authenticated = true
      console.log('Relay: NIP-42 authentication sent')

      await this.retryPendingAfterAuth()
    } catch (err) {
      console.error('Relay: Failed to handle auth challenge:', err)
      this.failPendingAuthRetry(
        err instanceof AuthSignerError
          ? err
          : new AuthSignerError(err instanceof Error ? err.message : String(err)),
      )
    }
  },

  failPendingAuthRetry(err: Error): void {
    for (const pending of this.pendingAuthRetry.values()) {
      pending.reject(err)
    }
    this.pendingAuthRetry.clear()
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
        this.armPublishTimer(pending)
        console.log('Relay: Retried event', eventId.slice(0, 8) + '...')
      } catch (err) {
        console.error('Relay: Failed to retry event', eventId.slice(0, 8) + '...:', err)
        pending.reject(err as Error)
        this.pendingPublishes.delete(eventId)
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
      const pending: PendingPublish = {
        event: signedEvent,
        timeout: undefined,
        resolve: (result) => {
          clearTimeout(pending.timeout)
          resolve(result)
        },
        reject: (err) => {
          clearTimeout(pending.timeout)
          reject(err)
        },
      }
      this.pendingPublishes.set(signedEvent.id, pending)

      try {
        this.send(['EVENT', signedEvent])
        this.armPublishTimer(pending)
        console.log('Relay: Published event', signedEvent.id.slice(0, 8) + '...')
      } catch (err) {
        this.pendingPublishes.delete(signedEvent.id)
        reject(err as Error)
      }
    })
  },

  /** (Re)start the round trip for one send of a pending publish. */
  armPublishTimer(pending: PendingPublish): void {
    clearTimeout(pending.timeout)
    const id = pending.event.id
    pending.timeout = setTimeout(() => {
      const fail = () => {
        this.pendingPublishes.delete(id)
        this.pendingAuthRetry.delete(id)
        pending.reject(new PublishTimeoutError(PUBLISH_TIMEOUT_MS))
      }
      // Parked for auth: never accepted, nothing to look up.
      if (this.pendingPublishes.get(id) !== pending) return fail()
      // Sent and unanswered. A late OK during the lookup still resolves it.
      this.query([{ ids: [id] }], PUBLISH_VERIFY_TIMEOUT_MS).then(
        (events) => {
          if (!events.some((e) => e.id === id)) return fail()
          this.pendingPublishes.delete(id)
          pending.resolve({ success: true, message: 'held by relay (OK not received)' })
        },
        fail,
      )
    }, PUBLISH_TIMEOUT_MS)
  },

  async subscribe(filter: NostrFilter, timeout = 10000): Promise<SignedEvent[]> {
    return this.query([filter], timeout)
  },

  /** One REQ carrying every filter (NIP-01), resolved with the events up to EOSE. */
  async query(filters: NostrFilter[], timeout = 10000): Promise<SignedEvent[]> {
    if (filters.length === 0) throw new Error('Relay.query needs at least one filter')
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

      this.send(['REQ', subId, ...filters])
    })
  },

  disconnect(): void {
    this.connecting = null
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
    this.connected = false
    this.authenticated = false
    // Settle now (reject also clears each publish timer) rather than letting
    // callers wait out PUBLISH_TIMEOUT_MS on a socket that is gone.
    const gone = new Error('Relay disconnected')
    for (const pending of this.pendingPublishes.values()) pending.reject(gone)
    for (const pending of this.pendingAuthRetry.values()) pending.reject(gone)
    this.pendingPublishes.clear()
    this.pendingAuthRetry.clear()
  },

  isConnected(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN
  },
}

export type RelayModule = typeof Relay
export default Relay
