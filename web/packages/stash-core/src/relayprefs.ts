// Relay Preferences Module
// Mirrors cloistr-common/relayprefs. Resolves a user's read/write relays via
// the discovery service, then a direct relay query (cloistr-relays kind:30078
// d=cloistr-relays, then NIP-65 kind:10002), then a default fallback.
//
// PORTED VERBATIM from legacy/js/relayprefs.js. The global `Relay` is now the
// imported ported module; the global `Auth` is injected via configure() as a
// typed RelayPrefsAuthPort.

import { Relay } from './relay'
import type { SignedEvent, UnsignedEvent } from './relay'

export interface RelayPreferences {
  readRelays: string[]
  writeRelays: string[]
  source?: string
  cachedAt: number
}

export interface RelaySetting {
  url: string
  read: boolean
  write: boolean
}

/** Auth surface relay-prefs publishing needs. */
export interface RelayPrefsAuthPort {
  readonly isConnected: boolean
  readonly pubkey: string | null
  signEvent(event: UnsignedEvent): Promise<SignedEvent>
}

export const RelayPrefs = {
  DISCOVERY_URL: 'https://discover.cloistr.xyz',
  DEFAULT_RELAY: 'wss://relay.cloistr.xyz',

  cache: new Map<string, RelayPreferences>(),
  CACHE_TTL: 60 * 60 * 1000, // 1 hour

  KIND: 30078,
  D_TAG: 'cloistr-relays',
  NIP65_KIND: 10002,

  auth: null as RelayPrefsAuthPort | null,

  configure(deps: { auth?: RelayPrefsAuthPort | null }): void {
    if (deps.auth !== undefined) this.auth = deps.auth
  },

  async getRelayPrefs(pubkey?: string | null): Promise<RelayPreferences> {
    if (!pubkey) {
      return this.defaultPrefs()
    }

    const cached = this.getFromCache(pubkey)
    if (cached) {
      console.log('RelayPrefs: Using cached preferences for', pubkey.slice(0, 8))
      return cached
    }

    try {
      const prefs = await this.queryDiscovery(pubkey)
      if (prefs) {
        this.setCache(pubkey, prefs)
        return prefs
      }
    } catch (err) {
      console.warn('RelayPrefs: Discovery query failed:', (err as Error).message)
    }

    try {
      const prefs = await this.queryRelayDirect(pubkey)
      if (prefs) {
        this.setCache(pubkey, prefs)
        return prefs
      }
    } catch (err) {
      console.warn('RelayPrefs: Direct relay query failed:', (err as Error).message)
    }

    const defaultPrefs = this.defaultPrefs()
    this.setCache(pubkey, defaultPrefs)
    return defaultPrefs
  },

  async queryDiscovery(pubkey: string): Promise<RelayPreferences | null> {
    const url = `${this.DISCOVERY_URL}/api/v1/relay-prefs/${pubkey}`
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })

    if (!response.ok) {
      if (response.status === 404) return null
      throw new Error(`Discovery returned ${response.status}`)
    }

    const data = await response.json()
    return this.parseDiscoveryResponse(data)
  },

  parseDiscoveryResponse(data: {
    relays?: Array<{ url: string; read?: boolean; write?: boolean }>
    source?: string
  }): RelayPreferences | null {
    if (!data || !data.relays || data.relays.length === 0) {
      return null
    }

    const readRelays: string[] = []
    const writeRelays: string[] = []

    for (const relay of data.relays) {
      if (relay.read) readRelays.push(relay.url)
      if (relay.write) writeRelays.push(relay.url)
    }

    if (readRelays.length === 0 && writeRelays.length === 0) {
      return null
    }

    return { readRelays, writeRelays, source: data.source || 'discovery', cachedAt: Date.now() }
  },

  async queryRelayDirect(pubkey: string): Promise<RelayPreferences | null> {
    if (!Relay.connected) {
      await Relay.connect()
    }

    let prefs = await this.queryForEvent(pubkey, this.KIND, this.D_TAG)
    if (prefs) {
      prefs.source = 'cloistr-relays'
      return prefs
    }

    prefs = await this.queryForNIP65(pubkey)
    if (prefs) {
      prefs.source = 'nip65'
      return prefs
    }

    return null
  },

  queryForEvent(pubkey: string, kind: number, dTag: string): Promise<RelayPreferences | null> {
    return new Promise((resolve) => {
      const subId = 'relayprefs-' + Date.now()
      const filter = { kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve(null)
        }
      }, 5000)

      const originalHandler = Relay.socket!.onmessage
      Relay.socket!.onmessage = (msg: MessageEvent) => {
        try {
          const message = JSON.parse(msg.data)
          if (message[0] === 'EVENT' && message[1] === subId) {
            const event = message[2]
            clearTimeout(timeout)
            resolved = true
            Relay.send(['CLOSE', subId])
            Relay.socket!.onmessage = originalHandler
            resolve(this.parseRelayTags(event.tags))
          } else if (message[0] === 'EOSE' && message[1] === subId) {
            if (!resolved) {
              clearTimeout(timeout)
              resolved = true
              Relay.send(['CLOSE', subId])
              Relay.socket!.onmessage = originalHandler
              resolve(null)
            }
          } else if (originalHandler) {
            originalHandler.call(Relay.socket!, msg)
          }
        } catch (err) {
          console.warn('RelayPrefs: Error processing cloistr-relays message:', (err as Error).message)
          if (originalHandler) originalHandler.call(Relay.socket!, msg)
        }
      }

      Relay.send(['REQ', subId, filter])
    })
  },

  queryForNIP65(pubkey: string): Promise<RelayPreferences | null> {
    return new Promise((resolve) => {
      const subId = 'nip65-' + Date.now()
      const filter = { kinds: [this.NIP65_KIND], authors: [pubkey], limit: 1 }

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve(null)
        }
      }, 5000)

      const originalHandler = Relay.socket!.onmessage
      Relay.socket!.onmessage = (msg: MessageEvent) => {
        try {
          const message = JSON.parse(msg.data)
          if (message[0] === 'EVENT' && message[1] === subId) {
            const event = message[2]
            clearTimeout(timeout)
            resolved = true
            Relay.send(['CLOSE', subId])
            Relay.socket!.onmessage = originalHandler
            resolve(this.parseRelayTags(event.tags))
          } else if (message[0] === 'EOSE' && message[1] === subId) {
            if (!resolved) {
              clearTimeout(timeout)
              resolved = true
              Relay.send(['CLOSE', subId])
              Relay.socket!.onmessage = originalHandler
              resolve(null)
            }
          } else if (originalHandler) {
            originalHandler.call(Relay.socket!, msg)
          }
        } catch (err) {
          console.warn('RelayPrefs: Error processing NIP-65 message:', (err as Error).message)
          if (originalHandler) originalHandler.call(Relay.socket!, msg)
        }
      }

      Relay.send(['REQ', subId, filter])
    })
  },

  // Parse relay tags from event (works for both cloistr-relays and NIP-65)
  parseRelayTags(tags: string[][]): RelayPreferences | null {
    const readRelays: string[] = []
    const writeRelays: string[] = []

    for (const tag of tags) {
      if (tag[0] !== 'r') continue
      const url = tag[1]
      if (!url || !url.startsWith('wss://')) continue
      const marker = tag[2] // 'read', 'write', or undefined (both)
      if (!marker || marker === 'read') readRelays.push(url)
      if (!marker || marker === 'write') writeRelays.push(url)
    }

    if (readRelays.length === 0 && writeRelays.length === 0) {
      return null
    }

    return { readRelays, writeRelays, cachedAt: Date.now() }
  },

  defaultPrefs(): RelayPreferences {
    return {
      readRelays: [this.DEFAULT_RELAY],
      writeRelays: [this.DEFAULT_RELAY],
      source: 'default',
      cachedAt: Date.now(),
    }
  },

  getFromCache(pubkey: string): RelayPreferences | null {
    const entry = this.cache.get(pubkey)
    if (!entry) return null
    if (Date.now() - entry.cachedAt > this.CACHE_TTL) {
      this.cache.delete(pubkey)
      return null
    }
    return entry
  },

  setCache(pubkey: string, prefs: RelayPreferences): void {
    this.cache.set(pubkey, prefs)
  },

  invalidateCache(pubkey?: string): void {
    if (pubkey) {
      this.cache.delete(pubkey)
    } else {
      this.cache.clear()
    }
  },

  createRelayPrefsEvent(relays: RelaySetting[]): UnsignedEvent {
    const tags: string[][] = [['d', this.D_TAG]]
    for (const relay of relays) {
      if (relay.read && relay.write) {
        tags.push(['r', relay.url])
      } else if (relay.read) {
        tags.push(['r', relay.url, 'read'])
      } else if (relay.write) {
        tags.push(['r', relay.url, 'write'])
      }
    }
    return { kind: this.KIND, created_at: Math.floor(Date.now() / 1000), tags, content: '' }
  },

  async publishRelayPrefs(relays: RelaySetting[]): Promise<SignedEvent> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Not connected')
    }

    const event = this.createRelayPrefsEvent(relays)
    const signedEvent = await this.auth.signEvent(event)

    const currentPrefs = await this.getRelayPrefs(this.auth.pubkey)

    const writeRelays = new Set<string>()
    for (const url of currentPrefs.writeRelays) writeRelays.add(url)
    for (const relay of relays) {
      if (relay.write) writeRelays.add(relay.url)
    }

    if (writeRelays.size === 0) {
      throw new Error('At least one relay must have write enabled to save preferences')
    }

    const publishPromises: Promise<unknown>[] = []
    for (const url of writeRelays) {
      publishPromises.push(this.publishToRelay(url, signedEvent))
    }

    const results = await Promise.allSettled(publishPromises)
    const successes = results.filter((r) => r.status === 'fulfilled').length
    console.log(`RelayPrefs: Published to ${successes}/${results.length} relays`)

    if (successes === 0) {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as Error)?.message || 'Unknown error')
        .join(', ')
      throw new Error(`Failed to publish to any relay: ${errors}`)
    }

    this.invalidateCache(this.auth.pubkey ?? undefined)
    return signedEvent
  },

  async publishToRelay(url: string, event: SignedEvent): Promise<unknown> {
    if (url === Relay.defaultUrl) {
      console.log('RelayPrefs: Using authenticated Relay.publish for', url)
      return Relay.publish(event)
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timeout'))
      }, 10000)

      ws.onopen = () => {
        ws.send(JSON.stringify(['EVENT', event]))
      }

      ws.onmessage = (msg) => {
        try {
          const message = JSON.parse(msg.data)
          if (message[0] === 'OK' && message[1] === event.id) {
            clearTimeout(timeout)
            ws.close()
            if (message[2]) {
              resolve({ success: true })
            } else {
              reject(new Error(message[3] || 'Rejected'))
            }
          }
        } catch (err) {
          console.warn('RelayPrefs: Failed to parse relay message:', (err as Error).message, msg.data)
        }
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('Connection failed'))
      }
    })
  },
}

export type RelayPrefsModule = typeof RelayPrefs
export default RelayPrefs
