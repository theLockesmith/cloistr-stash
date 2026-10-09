// Key management module - HKDF derivation, folder keys, encrypted key storage.
// Implements the zero-knowledge key hierarchy for Cloistr Stash.
//
// PORTED VERBATIM from legacy/js/keys.js. Backward-compatibility critical:
//   - IndexedDB name 'cloistr-drive-keys' and record shape are unchanged.
//   - HKDF context strings (cloistr-drive-*-v1) and the derivation params
//     (zero 32-byte salt, SHA-256, info = `${context}:${info}`, 256 bits)
//     are unchanged. Altering any of these orphans/garbles existing keys.
//
// The only structural change from the legacy module: the global `Auth` and
// `API` singletons are now injected via configure() as typed ports, so this
// module compiles standalone ahead of the auth/data-layer port. Behaviour is
// identical -- when a port is absent we take the same offline/base64 fallback
// paths the legacy `typeof Auth === 'undefined'` checks took.

import { Crypto } from './crypto'
import { type KeyRecord, type KeyStorage, IndexedDBKeyStorage } from './key-storage'
import {
  wrapKey,
  unwrapKey,
  wrapKeyForRecipient,
  unwrapKeyFromSender,
  generateContentKey,
  type ContentKey,
  type Envelope,
} from '@cloistr/auth/core'

export type { KeyRecord, KeyStorage }

/** Thrown when a refuseOverwrite key store already holds different key material for an id. */
export class KeyOverwriteRefusedError extends Error {
  constructor(public readonly keyId: string) {
    super(
      `Refusing to overwrite stored key '${keyId}' with different key material ` +
        `(files encrypted under the stored key would become unreadable). ` +
        `Delete it explicitly or pass { replace: true } to replace it.`,
    )
    this.name = 'KeyOverwriteRefusedError'
  }
}

/**
 * Thrown when new files would go into an own folder whose local key cannot be
 * verified (no relay copy, and not the derived key): it may have been planted
 * by a folder share accepted before 2026-10-09.
 */
export class FolderKeyUnverifiedError extends Error {
  constructor(public readonly folderId: string) {
    super(
      `This folder's key on this device cannot be verified, so new files are not ` +
        `being added to it. Existing files still open. Upload into a different folder.`,
    )
    this.name = 'FolderKeyUnverifiedError'
  }
}

export type OwnFolderKeyStatus = 'ok' | 'restored' | 'repaired' | 'unverified'

/** Order folders so every parent in the list comes before its children. */
function parentsFirst<T extends { id: string; parent_id?: string }>(folders: T[]): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const depth = (f: T): number => {
    let d = 0
    const seen = new Set<string>()
    for (let p = f.parent_id; p && byId.has(p) && !seen.has(p); p = byId.get(p)!.parent_id) {
      seen.add(p)
      d++
    }
    return d
  }
  return folders.map((f) => ({ f, d: depth(f) })).sort((a, b) => a.d - b.d).map((x) => x.f)
}

/**
 * Thrown when this device has no root key and the relay did not positively
 * answer whether one exists. A new root key is only ever created after the
 * relay said "none"; on a timeout or error creating one would replace the
 * user's real key and orphan everything derived from it.
 */
export class RootKeyUnavailableError extends Error {
  constructor(detail: string) {
    super(`Could not load your encryption key from the relay (${detail}). Nothing was changed; try again.`)
    this.name = 'RootKeyUnavailableError'
  }
}

/** Minimal Nostr signer/relay surface this module needs (provided by the auth layer). */
export interface AuthPort {
  readonly isConnected: boolean
  nip04Encrypt(pubkey: string, plaintext: string): Promise<string>
  nip04Decrypt(pubkey: string, ciphertext: string): Promise<string>
  // NIP-44 self-encryption. Optional: absent when the deployed signer/@cloistr/auth
  // predates NIP-44 support, in which case callers fall back to NIP-04. See
  // docs/migration-nip04-to-nip44-root-key.md.
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>
  createRootKeyEvent(encryptedKey: string): Promise<unknown>
  publishEvent(event: unknown): Promise<void>
}

/** Minimal server API surface this module needs (provided by the data layer). */
export interface ApiPort {
  getKeyring(pubkey: string): Promise<{ encrypted_root_key?: string } | null>
}

export const Keys = {
  // Key storage in IndexedDB (UNCHANGED for backward compat)
  DB_NAME: 'cloistr-drive-keys',
  DB_VERSION: 1,
  STORE_NAME: 'keys',

  // HKDF context strings (UNCHANGED for backward compat)
  CONTEXT_ROOT: 'cloistr-drive-root-v1',
  CONTEXT_FOLDER: 'cloistr-drive-folder-v1',
  CONTEXT_FILE: 'cloistr-drive-file-v1',
  CONTEXT_SHARE: 'cloistr-drive-share-v1',

  storage: null as KeyStorage | null,
  db: null as IDBDatabase | null,
  keyCache: new Map<string, Uint8Array>(),
  // Own folders whose local key could not be verified this session (see
  // resolveOwnFolderKeyStatus); new files are not added to them.
  unverifiedFolders: new Set<string>(),
  userPubkey: null as string | null,

  // Injected dependencies (formerly globals Auth / API)
  auth: null as AuthPort | null,
  api: null as ApiPort | null,

  // Write-gate for the NIP-04 -> NIP-44 root-key migration. Kept as a kill-switch
  // (disable via configure({nip44Writes:false})), but DEFAULT ON: the drive has
  // no stored files yet, so the lockout hazard is moot -- an unreadable root key
  // just gets regenerated, with no data behind it to lose. The read path
  // (selfDecrypt) accepts both schemes regardless. Revisit this default before
  // real user data exists. See docs/migration-nip04-to-nip44-root-key.md.
  nip44Writes: true as boolean,

  // True after the derivation-to-wrapping migration has completed. After this,
  // new file keys are generated randomly (not derived) and wrapped in events.
  wrappedKeyMode: false as boolean,

  // True when the root key exists locally but has NOT been confirmed published to
  // a relay. This means the key lives only in this browser's IndexedDB, and files
  // encrypted under it are unrecoverable from any other device. The UI should
  // surface this as a persistent warning and offer a retry.
  rootKeyLocalOnly: false as boolean,
  // The relay's last COMPLETED answer about this user's root key ('encrypted'
  // is null when the relay answered "none"). Null when it has not answered.
  rootKeyRelayAnswer: null as { pubkey: string; encrypted: string | null } | null,
  // True when this device's root key differs from the one on the relay. Neither
  // is overwritten; the UI should tell the user.
  rootKeyConflict: false as boolean,
  // One first-time root key resolution at a time: concurrent getRootKey calls
  // on a new device must not each generate (and store) a different key.
  _rootKeyInFlight: null as Promise<Uint8Array> | null,
  // The error message from the most recent publish failure, or null when the
  // last attempt succeeded. Shown to the user so they can distinguish "relay
  // down" from "auth-required" from "rate limit" without opening devtools.
  lastPublishError: null as string | null,
  // Listeners notified when rootKeyLocalOnly changes.
  _localOnlyListeners: new Set<(localOnly: boolean) => void>(),

  onRootKeyLocalOnlyChange(listener: (localOnly: boolean) => void): () => void {
    this._localOnlyListeners.add(listener)
    return () => { this._localOnlyListeners.delete(listener) }
  },

  _setRootKeyLocalOnly(localOnly: boolean): void {
    if (this.rootKeyLocalOnly !== localOnly) {
      this.rootKeyLocalOnly = localOnly
      for (const fn of this._localOnlyListeners) {
        try { fn(localOnly) } catch { /* listener errors are non-fatal */ }
      }
    }
  },

  configure(deps: { auth?: AuthPort | null; api?: ApiPort | null; nip44Writes?: boolean }): void {
    if (deps.auth !== undefined) this.auth = deps.auth
    if (deps.api !== undefined) this.api = deps.api
    if (deps.nip44Writes !== undefined) this.nip44Writes = deps.nip44Writes
  },

  setStorage(adapter: KeyStorage | null): void {
    this.storage = adapter
  },

  async ensureStorage(): Promise<KeyStorage> {
    if (!this.storage) {
      this.storage = new IndexedDBKeyStorage(this.DB_NAME, this.DB_VERSION, this.STORE_NAME)
    }
    await this.storage.init()
    return this.storage
  },

  async init(pubkey: string): Promise<void> {
    this.userPubkey = pubkey
    await this.openDB()
    await this.restoreRootKeyFromNostr()
    console.log('Keys: Initialized for', pubkey.slice(0, 8) + '...')
  },

  /**
   * Ask the server (which asks the relay) for this user's root-key event. Throws
   * RootKeyUnavailableError unless the answer is complete: the server returns
   * an error, never "none", when the relay times out or refuses.
   */
  async fetchRootKeyAnswer(): Promise<{ encrypted: string | null }> {
    const pubkey = this.userPubkey
    if (!pubkey) throw new RootKeyUnavailableError('not signed in')
    if (!this.api) throw new RootKeyUnavailableError('no keyring service')
    let res: { encrypted_root_key?: string } | null
    try {
      res = await this.api.getKeyring(pubkey)
    } catch (err) {
      throw new RootKeyUnavailableError((err as Error).message)
    }
    if (!res || typeof res !== 'object') throw new RootKeyUnavailableError('empty keyring response')
    // A sign-in switch while we waited: this answer is not about the current user.
    if (this.userPubkey !== pubkey) throw new RootKeyUnavailableError('account changed')
    const answer = { encrypted: res.encrypted_root_key || null }
    this.rootKeyRelayAnswer = { pubkey, ...answer }
    return answer
  },

  /** Decrypt the relay copy, save it locally and cache it. */
  async adoptRelayRootKey(encrypted: string): Promise<Uint8Array> {
    const rootKey = Crypto.hexToBytes(await this.selfDecrypt(this.userPubkey!, encrypted))
    await this.storeEncryptedKey('root', rootKey, null, { replace: true })
    this.keyCache.set('root', rootKey)
    this._setRootKeyLocalOnly(false)
    return rootKey
  },

  // Sync root key between local storage and Nostr for cross-device persistence.
  // Nothing is published or generated unless the relay completed its answer.
  async restoreRootKeyFromNostr(): Promise<void> {
    if (!this.userPubkey) return
    if (!this.auth || !this.auth.isConnected) {
      console.log('Keys: Auth not connected, skipping root key sync')
      return
    }

    try {
      const localKey = await this.loadEncryptedKey('root')
      if (localKey) this.keyCache.set('root', localKey)

      let answer: { encrypted: string | null }
      try {
        answer = await this.fetchRootKeyAnswer()
      } catch (err) {
        console.warn('Keys: Root key status unknown (relay did not answer); changing nothing:', (err as Error).message)
        return
      }

      if (localKey && answer.encrypted) {
        const relayKey = Crypto.hexToBytes(await this.selfDecrypt(this.userPubkey, answer.encrypted))
        if (Crypto.bytesToHex(relayKey) !== Crypto.bytesToHex(localKey)) {
          // Never overwrite either copy: files may exist under both.
          console.error('Keys: This device\'s root key differs from the relay copy; neither was changed')
          this.rootKeyConflict = true
          // Surface it through the existing root-key warning banner.
          this.lastPublishError = 'this device\'s root key differs from the one on the relay; neither was replaced'
          this._setRootKeyLocalOnly(true)
          return
        }
        console.log('Keys: Root key present locally and in Nostr')
        this._setRootKeyLocalOnly(false)
        return
      }

      if (localKey) {
        console.log('Keys: Relay has no root key; publishing this device\'s key...')
        const published = await this.publishRootKeyToNostr(localKey)
        if (!published) {
          console.warn('Keys: Migration publish failed. Root key is local-only.')
        }
        return
      }

      if (answer.encrypted) {
        console.log('Keys: Restoring root key from Nostr...')
        await this.adoptRelayRootKey(answer.encrypted)
        console.log('Keys: Restored root key from Nostr')
        return
      }

      console.log('Keys: No root key found locally or in Nostr')
    } catch (err) {
      console.warn('Keys: Failed to sync root key:', (err as Error).message)
    }
  },

  async openDB(): Promise<void> {
    await this.ensureStorage()
  },

  // Generate the root key for a user. Master key from which all others derive.
  // Only after a fresh, COMPLETED relay answer of "none": if the relay has a
  // key we adopt it, and if it does not answer we throw rather than guess.
  async generateRootKey(): Promise<Uint8Array> {
    if (!this.userPubkey) {
      throw new Error('User not initialized')
    }
    const answer = await this.fetchRootKeyAnswer()
    if (answer.encrypted) {
      console.log('Keys: Relay already has a root key; using it instead of generating one')
      return this.adoptRelayRootKey(answer.encrypted)
    }
    const rootKey = Crypto.generateKey()
    await this.storeEncryptedKey('root', rootKey, null)
    this.keyCache.set('root', rootKey)
    const published = await this.publishRootKeyToNostr(rootKey)
    if (!published) {
      console.warn('Keys: Root key generated but NOT published to relay. This browser is the only copy.')
    }
    console.log('Keys: Generated new root key (published:', published, ')')
    return rootKey
  },

  // NIP-04 v-04 ciphertext always carries the literal '?iv=' separator; NIP-44 v2
  // is a single base64 blob (first decoded byte 0x02) and never contains it.
  isNip04Ciphertext(ciphertext: string): boolean {
    return ciphertext.includes('?iv=')
  },

  // Encrypt to `pubkey` (the RECIPIENT: own pubkey for self-wrap, or another
  // user's for shares). NIP-44 by default; NIP-04 fallback.
  async selfEncrypt(pubkey: string, plaintext: string): Promise<string> {
    if (this.nip44Writes && this.auth?.nip44Encrypt) {
      try {
        return await this.auth.nip44Encrypt(pubkey, plaintext)
      } catch (err) {
        console.warn('Keys: NIP-44 encrypt unavailable, falling back to NIP-04:', (err as Error).message)
      }
    }
    return this.auth!.nip04Encrypt(pubkey, plaintext)
  },

  // Scheme-aware decrypt from `pubkey`, accepting either NIP-04 (legacy) or
  // NIP-44. Ciphertext self-identifies (NIP-04 carries '?iv=').
  async selfDecrypt(pubkey: string, ciphertext: string): Promise<string> {
    if (this.isNip04Ciphertext(ciphertext)) {
      return this.auth!.nip04Decrypt(pubkey, ciphertext)
    }
    return this.auth!.nip44Decrypt!(pubkey, ciphertext)
  },

  // Publish root key to Nostr for persistence across devices/sessions (kind 30078, d='root-key').
  // Returns true when the relay accepted the event, false on any failure. Callers
  // MUST check the return value: a false means the key lives only in this browser.
  async publishRootKeyToNostr(rootKey: Uint8Array): Promise<boolean> {
    if (!this.auth || !this.auth.isConnected) {
      console.warn('Keys: Cannot publish root key - Auth not connected')
      return false
    }
    try {
      // The root-key event is replaceable: publishing over a different key the
      // relay holds would orphan everything under it. Check first; an
      // unanswered check refuses (the key stays local-only, retry later).
      const answer = await this.fetchRootKeyAnswer()
      if (answer.encrypted) {
        const relayKey = Crypto.hexToBytes(await this.selfDecrypt(this.userPubkey!, answer.encrypted))
        if (Crypto.bytesToHex(relayKey) === Crypto.bytesToHex(rootKey)) {
          this.lastPublishError = null
          this._setRootKeyLocalOnly(false)
          return true
        }
        this.rootKeyConflict = true
        throw new Error('the relay already holds a different root key; not replacing it')
      }
      const keyHex = Crypto.bytesToHex(rootKey)
      const encryptedKey = await this.selfEncrypt(this.userPubkey!, keyHex)
      const signedEvent = await this.auth.createRootKeyEvent(encryptedKey)
      await this.auth.publishEvent(signedEvent)
      console.log('Keys: Published root key to Nostr')
      this.lastPublishError = null
      this._setRootKeyLocalOnly(false)
      return true
    } catch (err) {
      const msg = (err as Error).message
      console.warn('Keys: Failed to publish root key to Nostr:', msg)
      this.lastPublishError = msg
      this._setRootKeyLocalOnly(true)
      return false
    }
  },

  // Retry publishing a local-only root key. Returns true on success.
  async retryPublishRootKey(): Promise<boolean> {
    const rootKey = this.keyCache.get('root')
    if (!rootKey) {
      const stored = await this.loadEncryptedKey('root')
      if (!stored) return false
      this.keyCache.set('root', stored)
      return this.publishRootKeyToNostr(stored)
    }
    return this.publishRootKeyToNostr(rootKey)
  },

  async getRootKey(): Promise<Uint8Array> {
    if (this.keyCache.has('root')) {
      return this.keyCache.get('root')!
    }
    const stored = await this.loadEncryptedKey('root')
    if (stored) {
      this.keyCache.set('root', stored)
      return stored
    }
    // No local key: generateRootKey adopts the relay copy, creates one only on
    // a completed "none", and throws RootKeyUnavailableError otherwise.
    if (!this._rootKeyInFlight) {
      this._rootKeyInFlight = this.generateRootKey().finally(() => {
        this._rootKeyInFlight = null
      })
    }
    return this._rootKeyInFlight
  },

  async generateFolderKey(folderId: string): Promise<Uint8Array> {
    const folderKey = Crypto.generateKey()
    await this.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId, { sharedBy: this.userPubkey ?? undefined })
    this.keyCache.set(`folder:${folderId}`, folderKey)
    console.log('Keys: Generated folder key for', folderId.slice(0, 8) + '...')
    return folderKey
  },

  async getFolderKey(folderId: string, parentFolderId: string | null = null): Promise<Uint8Array> {
    const cacheKey = `folder:${folderId}`

    if (this.keyCache.has(cacheKey)) {
      return this.keyCache.get(cacheKey)!
    }

    const stored = await this.loadEncryptedKey(cacheKey)
    if (stored) {
      this.keyCache.set(cacheKey, stored)
      return stored
    }

    if (parentFolderId) {
      const parentKey = await this.getFolderKey(parentFolderId)
      const derivedKey = await this.deriveKey(parentKey, folderId, this.CONTEXT_FOLDER)
      this.keyCache.set(cacheKey, derivedKey)
      await this.storeEncryptedKey(cacheKey, derivedKey, folderId)
      return derivedKey
    }

    const rootKey = await this.getRootKey()
    const derivedKey = await this.deriveKey(rootKey, folderId, this.CONTEXT_FOLDER)
    this.keyCache.set(cacheKey, derivedKey)
    await this.storeEncryptedKey(cacheKey, derivedKey, folderId)
    return derivedKey
  },

  async deriveFileKey(folderId: string, fileId: string): Promise<Uint8Array> {
    const folderKey = await this.getFolderKey(folderId)
    return this.deriveKey(folderKey, fileId, this.CONTEXT_FILE)
  },

  async deriveRootFileKey(fileId: string): Promise<Uint8Array> {
    const rootKey = await this.getRootKey()
    return this.deriveKey(rootKey, fileId, this.CONTEXT_FILE)
  },

  // HKDF key derivation using Web Crypto API. Derives a 256-bit key.
  // EXACT params preserved: zero 32-byte salt, SHA-256, info = `${context}:${info}`.
  async deriveKey(inputKey: Uint8Array, info: string, context: string): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      inputKey as BufferSource,
      { name: 'HKDF' },
      false,
      ['deriveBits'],
    )

    const encoder = new TextEncoder()
    const infoBytes = encoder.encode(`${context}:${info}`)

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32) as BufferSource, // Zero salt (key material is already random)
        info: infoBytes as BufferSource,
      },
      keyMaterial,
      256,
    )

    return new Uint8Array(derivedBits)
  },

  async storeEncryptedKey(
    keyId: string,
    key: Uint8Array,
    associatedId: string | null,
    opts?: { replace?: boolean; sharedBy?: string; verifiedTag?: string },
  ): Promise<void> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Cannot store key: signer not connected')
    }
    const storage = await this.ensureStorage()

    // Refuse-to-overwrite (backends that opt in, e.g. FileKeyStorage): replacing
    // a stored key with different bytes orphans everything encrypted under it.
    // Re-storing the SAME key (re-wrap) is fine; an existing record we cannot
    // decrypt is treated as different, since we cannot prove it is the same.
    if (storage.refuseOverwrite && !opts?.replace) {
      const existing = await storage.get(`${this.userPubkey}:${keyId}`)
      if (existing) {
        let existingKey: Uint8Array | null = null
        try {
          existingKey = Crypto.hexToBytes(await this.selfDecrypt(this.userPubkey!, existing.encryptedKey))
        } catch {
          try {
            const raw = Crypto.base64ToBytes(existing.encryptedKey)
            if (raw.length === 32) existingKey = raw
          } catch { /* undecryptable */ }
        }
        if (!existingKey || Crypto.bytesToHex(existingKey) !== Crypto.bytesToHex(key)) {
          throw new KeyOverwriteRefusedError(keyId)
        }
      }
    }

    const keyHex = Crypto.bytesToHex(key)
    const encryptedKey = await this.selfEncrypt(this.userPubkey!, keyHex)

    const record: KeyRecord = {
      id: `${this.userPubkey}:${keyId}`,
      pubkey: this.userPubkey!,
      keyId,
      type: keyId.split(':')[0],
      associatedId,
      encryptedKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(opts?.sharedBy ? { sharedBy: opts.sharedBy } : {}),
      ...(opts?.verifiedTag ? { verifiedTag: opts.verifiedTag } : {}),
    }

    await storage.put(record)
  },

  async loadEncryptedKey(keyId: string): Promise<Uint8Array | null> {
    const storage = await this.ensureStorage()
    const record = await storage.get(`${this.userPubkey}:${keyId}`)

    if (!record) return null

    try {
      if (this.auth && this.auth.isConnected) {
        const keyHex = await this.selfDecrypt(this.userPubkey!, record.encryptedKey)
        return Crypto.hexToBytes(keyHex)
      } else {
        return null
      }
    } catch (err) {
      try {
        const raw = Crypto.base64ToBytes(record.encryptedKey)
        if (raw.length === 32) {
          console.warn('Keys: Found legacy base64 key for', keyId, '— migrating to encrypted storage')
          if (this.auth && this.auth.isConnected) {
            void this.storeEncryptedKey(keyId, raw, record.associatedId, { sharedBy: record.sharedBy, verifiedTag: record.verifiedTag }).catch(() => {})
          }
          return raw
        }
      } catch { /* not valid base64 either */ }
      console.error('Keys: Failed to decrypt key:', err)
      return null
    }
  },

  /** Decode a self-encrypted (or legacy base64) key record payload; null if neither. */
  async decodeStoredKey(encryptedKey: string): Promise<Uint8Array | null> {
    try {
      return Crypto.hexToBytes(await this.selfDecrypt(this.userPubkey!, encryptedKey))
    } catch {
      try {
        const raw = Crypto.base64ToBytes(encryptedKey)
        if (raw.length === 32) return raw
      } catch { /* neither */ }
      return null
    }
  },

  async deleteKey(keyId: string): Promise<void> {
    const storage = await this.ensureStorage()
    this.keyCache.delete(keyId)
    await storage.delete(`${this.userPubkey}:${keyId}`)
  },

  /**
   * The one admission rule for a folder key arriving from outside this
   * browser's own derivation: an incoming share, or an entry in a backup file.
   * The browser's IndexedDB never refuses an overwrite on its own, so the rule
   * lives here and every store gets it:
   *  - no local key: store it. `from` is recorded as its provenance only when
   *    it names someone else; a key claiming to be ours must earn that from
   *    the relay copy (resolveOwnFolderKeyStatus), never from the caller;
   *  - the identical key: nothing to do;
   *  - a different key: replace only when `rotation` is allowed and the local
   *    key came from that same sender (they rotate after a revoke), or when
   *    `existingCameFromSender` positively proves a pre-provenance local key
   *    came from them. Ours, another sharer's, or unknown provenance: refuse.
   *    An empty or failed proof is UNKNOWN, and unknown refuses.
   * Found 2026-10-09: without this, anyone who learned one of our folder ids
   * could share it to us, and once accepted, new uploads into our folder were
   * wrapped under their key in the folder event's public 'wk' tags.
   */
  async admitFolderKey(
    folderId: string,
    key: Uint8Array,
    from: string | undefined,
    opts: { rotation: boolean; existingCameFromSender?: (existingKeyHex: string) => Promise<boolean> },
  ): Promise<Uint8Array> {
    const keyId = `folder:${folderId}`
    const keyHex = Crypto.bytesToHex(key)
    const foreignFrom = from && from !== this.userPubkey ? from : undefined
    const existing = await (await this.ensureStorage()).get(`${this.userPubkey}:${keyId}`)
    if (existing) {
      const current = await this.loadEncryptedKey(keyId)
      if (current && Crypto.bytesToHex(current) === keyHex) {
        this.keyCache.set(keyId, current)
        return current
      }
      let mayReplace = false
      if (opts.rotation && foreignFrom) {
        if (existing.sharedBy) {
          mayReplace = existing.sharedBy === foreignFrom
        } else if (current && opts.existingCameFromSender) {
          try {
            mayReplace = (await opts.existingCameFromSender(Crypto.bytesToHex(current))) === true
          } catch {
            mayReplace = false
          }
        }
      }
      if (!mayReplace) {
        console.warn('Keys: refused a folder key that would replace an existing key for', folderId.slice(0, 8) + '...')
        throw new KeyOverwriteRefusedError(keyId)
      }
    }
    await this.storeEncryptedKey(keyId, key, folderId, { replace: true, sharedBy: foreignFrom })
    this.keyCache.set(keyId, key)
    return key
  },

  /**
   * Store a folder key received in a share (see admitFolderKey for the rule).
   * `existingCameFromSender` is the only way to replace a local key saved
   * before provenance existed: it must find this sender's earlier share of the
   * folder carrying exactly the local key.
   */
  async importSharedFolderKey(
    folderId: string,
    encryptedKey: string,
    senderPubkey: string,
    opts?: { existingCameFromSender?: (existingKeyHex: string) => Promise<boolean> },
  ): Promise<Uint8Array> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Not connected')
    }
    // Our own self-encrypted copy (a folder event's 'key' tag) is authoritative.
    if (senderPubkey === this.userPubkey) {
      return this.resolveOwnFolderKey(folderId, encryptedKey, null)
    }
    const folderKey = Crypto.hexToBytes(await this.selfDecrypt(senderPubkey, encryptedKey))
    const key = await this.admitFolderKey(folderId, folderKey, senderPubkey, {
      rotation: true,
      existingCameFromSender: opts?.existingCameFromSender,
    })
    console.log('Keys: Imported shared folder key for', folderId.slice(0, 8) + '...')
    return key
  },

  /**
   * The key for a folder WE own. Its self-encrypted copy in the folder event's
   * 'key' tag is authoritative (only we can produce a self-encryption that
   * decrypts for us), so a local key that disagrees is replaced: this is what
   * repairs a browser poisoned before provenance existed. Without a tag, a
   * local key that came from someone else is dropped and the key is derived;
   * a pre-provenance local key that is not the derived key cannot be told
   * apart from a planted one, so it is 'unverified' and refused for writes.
   */
  // For WRITES into an own folder (wrap, share, migrate): throws
  // FolderKeyUnverifiedError rather than hand out an unverifiable key. Reads
  // use getFolderKey / fileKeyFor.
  async resolveOwnFolderKey(
    folderId: string,
    keyTag: string | undefined,
    parentId: string | null,
  ): Promise<Uint8Array> {
    const { key, status } = await this.resolveOwnFolderKeyStatus(folderId, keyTag, parentId)
    if (status === 'unverified') throw new FolderKeyUnverifiedError(folderId)
    return key
  },

  async resolveOwnFolderKeyStatus(
    folderId: string,
    keyTag: string | undefined,
    parentId: string | null,
  ): Promise<{ key: Uint8Array; status: OwnFolderKeyStatus; replaced?: Uint8Array }> {
    const keyId = `folder:${folderId}`
    const storage = await this.ensureStorage()
    const record = await storage.get(`${this.userPubkey}:${keyId}`)
    const foreign = !!record?.sharedBy && record.sharedBy !== this.userPubkey

    if (keyTag) {
      this.unverifiedFolders.delete(folderId)
      if (record && !foreign && record.verifiedTag === keyTag) {
        const local = await this.loadEncryptedKey(keyId)
        if (local) {
          this.keyCache.set(keyId, local)
          return { key: local, status: 'ok' }
        }
      }
      const real = Crypto.hexToBytes(await this.selfDecrypt(this.userPubkey!, keyTag))
      const local = record ? await this.loadEncryptedKey(keyId) : null
      const same = !!local && Crypto.bytesToHex(local) === Crypto.bytesToHex(real)
      await this.storeEncryptedKey(keyId, real, folderId, {
        replace: true,
        sharedBy: this.userPubkey ?? undefined,
        verifiedTag: keyTag,
      })
      this.keyCache.set(keyId, real)
      if (local && !same) {
        console.warn('Keys: repaired folder key for', folderId.slice(0, 8) + '...', '(local key did not match the relay copy)')
        return { key: real, status: 'repaired', replaced: local }
      }
      return { key: real, status: !record ? 'restored' : 'ok' }
    }

    // Untagged: any key here hangs off the parent's (or root's) key. Under an
    // unverified parent nothing can be vouched for, whatever is stored.
    this.unverifiedFolders.delete(folderId)
    if (parentId && this.unverifiedFolders.has(parentId)) {
      this.unverifiedFolders.add(folderId)
      return { key: await this.getFolderKey(folderId, parentId), status: 'unverified' }
    }

    if (foreign) {
      const local = await this.loadEncryptedKey(keyId)
      await this.deleteKey(keyId)
      this.unverifiedFolders.delete(folderId)
      console.warn('Keys: dropped a shared-in key for own folder', folderId.slice(0, 8) + '...')
      const derived = await this.getFolderKey(folderId, parentId)
      await this.storeEncryptedKey(keyId, derived, folderId, { replace: true, sharedBy: this.userPubkey ?? undefined })
      return { key: derived, status: 'repaired', ...(local ? { replaced: local } : {}) }
    }

    if (record && !record.sharedBy) {
      // Pre-provenance record on an untagged own folder. Untagged own folders
      // are derived (every folder we generate a key for gets a 'key' tag), so
      // the derived key is the only one we can vouch for.
      const local = await this.loadEncryptedKey(keyId)
      const expected = local ? await this.expectedDerivedFolderKey(folderId, parentId) : null
      if (local && expected && Crypto.bytesToHex(local) === Crypto.bytesToHex(expected)) {
        await this.storeEncryptedKey(keyId, local, folderId, { replace: true, sharedBy: this.userPubkey ?? undefined })
        this.keyCache.set(keyId, local)
        this.unverifiedFolders.delete(folderId)
        return { key: local, status: 'ok' }
      }
      if (local && expected) {
        console.warn('Keys: cannot verify the local key for own folder', folderId.slice(0, 8) + '...', '(no relay copy, not the derived key)')
        this.unverifiedFolders.add(folderId)
        this.keyCache.set(keyId, local)
        return { key: local, status: 'unverified' }
      }
    }
    return { key: await this.getFolderKey(folderId, parentId), status: 'ok' }
  },

  /**
   * The key an untagged own folder would have by derivation, or null when that
   * cannot be computed here without inventing a key (no local root or parent
   * key, or the parent's own key is itself unverified).
   */
  async expectedDerivedFolderKey(folderId: string, parentId: string | null): Promise<Uint8Array | null> {
    let base: Uint8Array | null
    if (parentId) {
      if (this.unverifiedFolders.has(parentId)) return null
      // Never derive the parent here: a tagged parent's key comes from its tag,
      // and inventing one would store a wrong key for it.
      base = this.keyCache.get(`folder:${parentId}`) ?? (await this.loadEncryptedKey(`folder:${parentId}`))
    } else {
      base = this.keyCache.get('root') ?? (await this.loadEncryptedKey('root'))
    }
    if (!base) return null
    return this.deriveKey(base, folderId, this.CONTEXT_FOLDER)
  },

  /**
   * After a folder's key was replaced, re-derive the untagged subfolders whose
   * stored keys were derived from the replaced key (and so are wrong too). A
   * child key is only touched when it provably equals the derivation from the
   * replaced key; any other stored key is left alone.
   */
  async rederiveChildFolderKeys(
    folders: Array<{ id: string; encrypted_key?: string; parent_id?: string }>,
    parentId: string,
    replaced: Uint8Array,
    real: Uint8Array,
    visited: Set<string> = new Set([parentId]),
  ): Promise<number> {
    let count = 0
    for (const child of folders) {
      if (child.parent_id !== parentId || child.encrypted_key || visited.has(child.id)) continue
      visited.add(child.id)
      const keyId = `folder:${child.id}`
      this.keyCache.delete(keyId)
      const stored = await this.loadEncryptedKey(keyId)
      if (!stored) continue
      const fromReplaced = await this.deriveKey(replaced, child.id, this.CONTEXT_FOLDER)
      if (Crypto.bytesToHex(stored) !== Crypto.bytesToHex(fromReplaced)) {
        this.keyCache.set(keyId, stored)
        continue
      }
      const fixed = await this.deriveKey(real, child.id, this.CONTEXT_FOLDER)
      await this.storeEncryptedKey(keyId, fixed, child.id, { replace: true, sharedBy: this.userPubkey ?? undefined })
      this.keyCache.set(keyId, fixed)
      this.unverifiedFolders.delete(child.id)
      console.warn('Keys: re-derived subfolder key for', child.id.slice(0, 8) + '...', '(its parent key was repaired)')
      count += 1 + (await this.rederiveChildFolderKeys(folders, child.id, stored, fixed, visited))
    }
    return count
  },

  /**
   * Check every listed OWN folder's local key against its relay copy, on every
   * load. Restores missing keys, repairs ones that disagree (and the derived
   * subfolders under them), and reports own folders whose key cannot be
   * verified. Parents are handled before children. Each tag is decrypted once
   * (verifiedTag), so steady-state loads cost no signer calls.
   */
  async restoreOwnFolderKeys(
    folders: Array<{ id: string; encrypted_key?: string; parent_id?: string; [k: string]: unknown }>,
  ): Promise<{ restored: number; repaired: number; errors: number; unverified: string[] }> {
    const result = { restored: 0, repaired: 0, errors: 0, unverified: [] as string[] }
    if (!this.auth?.isConnected || !this.userPubkey) return result
    const storage = await this.ensureStorage()
    // Recomputed below for every listed folder, so a flag never outlives its cause.
    for (const folder of folders) this.unverifiedFolders.delete(folder.id)
    for (const folder of parentsFirst(folders)) {
      try {
        const parentUnverified = !!folder.parent_id && this.unverifiedFolders.has(folder.parent_id)
        if (!folder.encrypted_key && !parentUnverified) {
          // Untagged: only act on a key that is not already known to be ours.
          const rec = await storage.get(`${this.userPubkey}:folder:${folder.id}`)
          if (!rec || rec.sharedBy === this.userPubkey) continue
        }
        const { key, status, replaced } = await this.resolveOwnFolderKeyStatus(
          folder.id,
          folder.encrypted_key,
          folder.parent_id ?? null,
        )
        if (status === 'restored') result.restored++
        if (status === 'repaired') result.repaired++
        if (status === 'unverified') result.unverified.push(folder.id)
        if (replaced) result.repaired += await this.rederiveChildFolderKeys(folders, folder.id, replaced, key)
      } catch (err) {
        console.error('Keys: could not verify folder key for', folder.id, ':', (err as Error).message)
        result.errors++
      }
    }
    if (result.restored || result.repaired || result.errors || result.unverified.length) {
      console.log(
        `Keys: own folder keys: ${result.restored} restored, ${result.repaired} repaired, ` +
          `${result.unverified.length} unverified, ${result.errors} errors`,
      )
    }
    return result
  },

  /** Throws FolderKeyUnverifiedError if new files must not go into this folder. */
  assertFolderKeyUsable(folderId: string): void {
    if (this.unverifiedFolders.has(folderId)) throw new FolderKeyUnverifiedError(folderId)
  },

  // ── Envelope key wrapping (derivation → wrapping migration) ────────────

  generateFileKey(): Uint8Array {
    return generateContentKey()
  },

  wrapFileKeyForFolder(fileKey: Uint8Array, fileId: string, folderKey: Uint8Array): Envelope {
    return wrapKey(fileKey as ContentKey, fileId, folderKey as ContentKey)
  },

  unwrapFileKeyFromFolder(envelope: Envelope, fileId: string, folderKey: Uint8Array): Uint8Array {
    return unwrapKey(envelope, fileId, folderKey as ContentKey)
  },

  async wrapFileKeyForOwner(fileKey: Uint8Array, fileId: string, signer: unknown): Promise<Envelope> {
    if (!this.userPubkey) throw new Error('User not initialized')
    return wrapKeyForRecipient(
      fileKey as ContentKey,
      fileId,
      this.userPubkey,
      signer as Parameters<typeof wrapKeyForRecipient>[3],
    )
  },

  async unwrapFileKeyFromOwner(envelope: Envelope, fileId: string, signer: unknown): Promise<Uint8Array> {
    if (!this.userPubkey) throw new Error('User not initialized')
    return unwrapKeyFromSender(
      envelope,
      fileId,
      this.userPubkey,
      signer as Parameters<typeof unwrapKeyFromSender>[3],
    )
  },

  async getFileKey(
    folderId: string | null,
    fileId: string,
    opts?: { ownerEnvelope?: string; folderWrappedKeys?: Array<{ subject: string; envelope: string }>; signer?: unknown },
  ): Promise<Uint8Array> {
    // 1. Owner envelope present → file was encrypted with a wrapped key.
    //    HKDF derivation will NOT produce the right key, so always throw on failure.
    if (opts?.ownerEnvelope && opts?.signer) {
      try {
        return await this.unwrapFileKeyFromOwner(opts.ownerEnvelope, fileId, opts.signer)
      } catch (err) {
        throw new Error(`Failed to unwrap owner envelope for ${fileId}: ${(err as Error).message}`)
      }
    }

    // 2. Folder wrapped key entry exists → same: always throw on failure.
    if (opts?.folderWrappedKeys && folderId) {
      const entry = opts.folderWrappedKeys.find((wk) => wk.subject === fileId)
      if (entry) {
        try {
          const folderKey = await this.getFolderKey(folderId)
          return this.unwrapFileKeyFromFolder(entry.envelope, fileId, folderKey)
        } catch (err) {
          throw new Error(`Failed to unwrap folder key for ${fileId}: ${(err as Error).message}`)
        }
      }
    }

    // 3. No wrapped key on this file → HKDF derivation (pre-migration)
    return folderId ? this.deriveFileKey(folderId, fileId) : this.deriveRootFileKey(fileId)
  },

  async getPublicLinkKey(folderId: string | null, fileId: string): Promise<string> {
    const key = folderId ? await this.deriveFileKey(folderId, fileId) : await this.deriveRootFileKey(fileId)
    return Crypto.bytesToBase64url(key)
  },

  parsePublicLinkKey(base64urlKey: string): Uint8Array {
    return Crypto.base64urlToBytes(base64urlKey)
  },

  clearCache(): void {
    for (const key of this.keyCache.values()) {
      Crypto.wipeKey(key)
    }
    this.keyCache.clear()
    this.unverifiedFolders.clear()
    this.rootKeyRelayAnswer = null
    this.rootKeyConflict = false
    this._rootKeyInFlight = null
    this.userPubkey = null
    this.wrappedKeyMode = false
    console.log('Keys: Cache cleared')
  },

  async clearAllKeys(): Promise<void> {
    if (!this.userPubkey) {
      this.clearCache()
      return
    }
    if (!this.db) {
      this.clearCache()
      return
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite')
      const store = tx.objectStore(this.STORE_NAME)
      const index = store.index('pubkey')
      const request = index.openCursor(IDBKeyRange.only(this.userPubkey))
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          this.clearCache()
          resolve()
        }
      }
      request.onerror = () => reject(request.error)
    })
  },

  async hasFolderKey(folderId: string): Promise<boolean> {
    if (this.keyCache.has(`folder:${folderId}`)) {
      return true
    }
    const stored = await this.loadEncryptedKey(`folder:${folderId}`)
    return stored !== null
  },

  async getAllFolderIds(): Promise<(string | null)[]> {
    if (!this.db) {
      const ids: (string | null)[] = []
      for (const [k] of this.keyCache) {
        if (k.startsWith('folder:')) ids.push(k.replace('folder:', ''))
      }
      return ids
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly')
      const store = tx.objectStore(this.STORE_NAME)
      const index = store.index('pubkey')
      const request = index.getAll(IDBKeyRange.only(this.userPubkey))
      request.onsuccess = () => {
        const folderIds = (request.result as KeyRecord[])
          .filter((r) => r.type === 'folder')
          .map((r) => r.associatedId)
        resolve(folderIds)
      }
      request.onerror = () => reject(request.error)
    })
  },

  async exportBackup(): Promise<{
    encrypted: string
    hash: string
    pubkey: string
    version: number
    createdAt: number
  }> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Not connected')
    }
    if (!this.db) {
      throw new Error('Backup requires browser storage')
    }

    const allKeys = await new Promise<KeyRecord[]>((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly')
      const store = tx.objectStore(this.STORE_NAME)
      const index = store.index('pubkey')
      const request = index.getAll(IDBKeyRange.only(this.userPubkey))
      request.onsuccess = () => resolve(request.result as KeyRecord[])
      request.onerror = () => reject(request.error)
    })

    const backup = {
      version: 1,
      createdAt: Date.now(),
      pubkey: this.userPubkey,
      keys: allKeys.map((k) => ({
        keyId: k.keyId,
        type: k.type,
        associatedId: k.associatedId,
        encryptedKey: k.encryptedKey,
        ...(k.sharedBy && k.sharedBy !== this.userPubkey ? { sharedBy: k.sharedBy } : {}),
      })),
    }

    const backupString = JSON.stringify(backup)
    const backupHash = await Crypto.hash(new TextEncoder().encode(backupString))
    const encryptedBackup = await this.selfEncrypt(this.userPubkey!, backupString)

    return {
      encrypted: encryptedBackup,
      hash: backupHash,
      pubkey: this.userPubkey!,
      version: 1,
      createdAt: backup.createdAt,
    }
  },

  async importBackup(backupData: {
    encrypted: string
    hash: string
    pubkey: string
  }): Promise<{ imported: number; total: number; refused: number }> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Not connected')
    }
    if (backupData.pubkey !== this.userPubkey) {
      throw new Error('Backup is for a different user')
    }
    const decryptedString = await this.selfDecrypt(this.userPubkey!, backupData.encrypted)
    const backup = JSON.parse(decryptedString) as {
      createdAt: number
      keys: Array<{ keyId: string; type: string; associatedId: string | null; encryptedKey: string; sharedBy?: string }>
    }

    const computedHash = await Crypto.hash(new TextEncoder().encode(decryptedString))
    if (computedHash !== backupData.hash) {
      console.warn('Keys: Backup hash mismatch (may be truncated/modified)')
    }

    // A backup only ever fills in keys this device lacks. Folder keys go
    // through admitFolderKey (the same rule as an incoming share, with no
    // rotation); any other key is never replaced by different bytes. A key the
    // backup calls ours is stored without provenance and has to be confirmed
    // against the relay copy on the next load, like any pre-provenance key.
    const storage = await this.ensureStorage()
    let imported = 0
    let refused = 0
    for (const keyData of backup.keys) {
      try {
        const key = await this.decodeStoredKey(keyData.encryptedKey)
        if (!key) throw new Error('undecryptable key')
        if (keyData.type === 'folder' && keyData.keyId.startsWith('folder:')) {
          const folderId = keyData.keyId.slice('folder:'.length)
          await this.admitFolderKey(folderId, key, keyData.sharedBy, { rotation: false })
        } else {
          const existing = await storage.get(`${this.userPubkey}:${keyData.keyId}`)
          const current = existing ? await this.loadEncryptedKey(keyData.keyId) : null
          if (existing && (!current || Crypto.bytesToHex(current) !== Crypto.bytesToHex(key))) {
            throw new KeyOverwriteRefusedError(keyData.keyId)
          }
          if (!existing) await this.storeEncryptedKey(keyData.keyId, key, keyData.associatedId, { replace: true })
        }
        imported++
      } catch (err) {
        if (err instanceof KeyOverwriteRefusedError) refused++
        console.warn(`Keys: Did not import key ${keyData.keyId}:`, (err as Error).message)
      }
    }
    if (refused) console.warn(`Keys: backup import kept ${refused} existing keys that differ from the backup`)

    this.clearCache()
    this.userPubkey = backupData.pubkey

    console.log(`Keys: Imported ${imported} keys from backup`)
    return { imported, total: backup.keys.length, refused }
  },
}

export type KeysModule = typeof Keys
export default Keys
