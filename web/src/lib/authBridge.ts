// Auth bridge: adapts @cloistr/collab-common's signer + auth state into the
// typed ports the ported data-layer modules need (keys.ts AuthPort, relay.ts
// RelayAuthPort, relayprefs.ts RelayPrefsAuthPort).
//
// This is the seam that replaces the legacy global `Auth` singleton. The React
// layer calls updateAuth() whenever the collab-common signer/auth-state change;
// the ported modules read the current values through this single port object.

import { API } from './api'
import { Keys } from './keys'
import { Relay } from './relay'
import type { SignedEvent, UnsignedEvent } from './relay'
import { RelayPrefs } from './relayprefs'

/** Structural shape of collab-common's SignerInterface (avoids a hard type import). */
export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent): Promise<SignedEvent>
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}

export interface AuthSnapshot {
  isConnected: boolean
  pubkey: string | null
}

const ROOT_KEY_KIND = 30078 // parameterized-replaceable; d='root-key'

// Mutable current auth, updated by updateAuth(). Port getters read these so the
// ports always reflect the latest signer/session without re-wiring callers.
let currentSigner: Signer | null = null
let currentState: AuthSnapshot = { isConnected: false, pubkey: null }

function requireSigner(): Signer {
  if (!currentSigner) throw new Error('Not connected')
  return currentSigner
}

// One port object implementing every interface the ported modules require.
const authPort = {
  get isConnected(): boolean {
    return currentState.isConnected && !!currentSigner
  },
  get pubkey(): string | null {
    return currentState.pubkey
  },

  // NIP-04/44 self-encryption (collab-common signer.encrypt/decrypt)
  async nip04Encrypt(pubkey: string, plaintext: string): Promise<string> {
    return requireSigner().encrypt(pubkey, plaintext)
  },
  async nip04Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    return requireSigner().decrypt(pubkey, ciphertext)
  },

  async signEvent(event: UnsignedEvent): Promise<SignedEvent> {
    return requireSigner().signEvent(event)
  },

  // Root-key storage event (kind 30078, d='root-key', encrypted key in 'key' tag).
  // Shape preserved from legacy Auth.createRootKeyEvent for keyring compatibility.
  async createRootKeyEvent(encryptedKey: string): Promise<SignedEvent> {
    const event: UnsignedEvent = {
      kind: ROOT_KEY_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'root-key'],
        ['key', encryptedKey],
      ],
      content: '',
    }
    return requireSigner().signEvent(event)
  },

  async publishEvent(event: unknown): Promise<void> {
    await Relay.publish(event as SignedEvent)
  },
}

export type AuthPortImpl = typeof authPort

/** Wire the ported data-layer singletons to the bridge port (idempotent). */
let wired = false
function wireOnce(): void {
  if (wired) return
  Keys.configure({ auth: authPort, api: API })
  Relay.configure({ auth: authPort })
  RelayPrefs.configure({ auth: authPort })
  wired = true
}

/**
 * Update the current signer/auth state and ensure the data layer is wired.
 * Call from React whenever useNostrAuth()'s signer or authState changes.
 * Initializes the key store on first connect, and clears caches on disconnect.
 */
export async function updateAuth(signer: Signer | null, state: AuthSnapshot): Promise<void> {
  const wasConnected = currentState.isConnected && !!currentSigner
  currentSigner = signer
  currentState = state
  wireOnce()

  const isConnected = state.isConnected && !!signer
  if (isConnected && state.pubkey && !wasConnected) {
    await Keys.init(state.pubkey)
  } else if (!isConnected && wasConnected) {
    Keys.clearCache()
    Relay.disconnect()
  }
}

export { authPort }
