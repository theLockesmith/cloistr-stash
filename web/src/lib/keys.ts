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

interface KeyRecord {
  id: string
  pubkey: string
  keyId: string
  type: string
  associatedId: string | null
  encryptedKey: string
  createdAt: number
  updatedAt: number
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

  db: null as IDBDatabase | null,
  keyCache: new Map<string, Uint8Array>(),
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

  configure(deps: { auth?: AuthPort | null; api?: ApiPort | null; nip44Writes?: boolean }): void {
    if (deps.auth !== undefined) this.auth = deps.auth
    if (deps.api !== undefined) this.api = deps.api
    if (deps.nip44Writes !== undefined) this.nip44Writes = deps.nip44Writes
  },

  async init(pubkey: string): Promise<void> {
    this.userPubkey = pubkey
    await this.openDB()
    await this.restoreRootKeyFromNostr()
    console.log('Keys: Initialized for', pubkey.slice(0, 8) + '...')
  },

  // Sync root key between local storage and Nostr for cross-device persistence
  async restoreRootKeyFromNostr(): Promise<void> {
    if (!this.userPubkey) return
    if (!this.auth || !this.auth.isConnected) {
      console.log('Keys: Auth not connected, skipping root key sync')
      return
    }

    try {
      const localKey = await this.loadEncryptedKey('root')
      const nostrResult = this.api ? await this.api.getKeyring(this.userPubkey) : null
      const hasNostrKey = !!(nostrResult && nostrResult.encrypted_root_key)

      if (localKey && hasNostrKey) {
        console.log('Keys: Root key present locally and in Nostr')
        this.keyCache.set('root', localKey)
        return
      }

      if (localKey && !hasNostrKey) {
        console.log('Keys: Migrating local root key to Nostr...')
        this.keyCache.set('root', localKey)
        await this.publishRootKeyToNostr(localKey)
        return
      }

      if (!localKey && hasNostrKey) {
        console.log('Keys: Restoring root key from Nostr...')
        const keyHex = await this.selfDecrypt(this.userPubkey, nostrResult!.encrypted_root_key!)
        const rootKey = Crypto.hexToBytes(keyHex)
        await this.storeEncryptedKey('root', rootKey, null)
        this.keyCache.set('root', rootKey)
        console.log('Keys: Restored root key from Nostr')
        return
      }

      console.log('Keys: No root key found locally or in Nostr')
    } catch (err) {
      console.warn('Keys: Failed to sync root key:', (err as Error).message)
    }
  },

  async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' })
          store.createIndex('pubkey', 'pubkey', { unique: false })
          store.createIndex('type', 'type', { unique: false })
        }
      }
    })
  },

  // Generate the root key for a user. Master key from which all others derive.
  async generateRootKey(): Promise<Uint8Array> {
    if (!this.userPubkey) {
      throw new Error('User not initialized')
    }
    const rootKey = Crypto.generateKey()
    await this.storeEncryptedKey('root', rootKey, null)
    this.keyCache.set('root', rootKey)
    await this.publishRootKeyToNostr(rootKey)
    console.log('Keys: Generated new root key')
    return rootKey
  },

  // NIP-04 v-04 ciphertext always carries the literal '?iv=' separator; NIP-44 v2
  // is a single base64 blob (first decoded byte 0x02) and never contains it.
  isNip04Ciphertext(ciphertext: string): boolean {
    return ciphertext.includes('?iv=')
  },

  // Scheme-aware encrypt to `pubkey` (own pubkey for self-wrap, or a recipient's
  // for shares). Writes NIP-04 unless the NIP-44 write-gate is enabled AND the
  // signer supports NIP-44; falls back to NIP-04 if the NIP-44 attempt fails.
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

  // Scheme-aware decrypt from `pubkey`, accepting either scheme: NIP-04 (legacy
  // root-key events / legacy shares) or NIP-44 (new). Ciphertext self-identifies
  // (NIP-04 carries '?iv='), so no version tag is needed. Falls back defensively.
  async selfDecrypt(pubkey: string, ciphertext: string): Promise<string> {
    if (this.isNip04Ciphertext(ciphertext)) {
      return this.auth!.nip04Decrypt(pubkey, ciphertext)
    }
    if (this.auth?.nip44Decrypt) {
      try {
        return await this.auth.nip44Decrypt(pubkey, ciphertext)
      } catch (err) {
        console.warn('Keys: NIP-44 decrypt failed, trying NIP-04:', (err as Error).message)
      }
    }
    return this.auth!.nip04Decrypt(pubkey, ciphertext)
  },

  // Publish root key to Nostr for persistence across devices/sessions (kind 30078, d='root-key')
  async publishRootKeyToNostr(rootKey: Uint8Array): Promise<void> {
    if (!this.auth || !this.auth.isConnected) {
      console.warn('Keys: Cannot publish root key - Auth not connected')
      return
    }
    try {
      const keyHex = Crypto.bytesToHex(rootKey)
      const encryptedKey = await this.selfEncrypt(this.userPubkey!, keyHex)
      const signedEvent = await this.auth.createRootKeyEvent(encryptedKey)
      await this.auth.publishEvent(signedEvent)
      console.log('Keys: Published root key to Nostr')
    } catch (err) {
      console.warn('Keys: Failed to publish root key to Nostr:', (err as Error).message)
    }
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
    return this.generateRootKey()
  },

  async generateFolderKey(folderId: string): Promise<Uint8Array> {
    const folderKey = Crypto.generateKey()
    await this.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId)
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

  // Store an encrypted key in IndexedDB. Encrypted with the user's Nostr key (NIP-04/44),
  // falling back to base64 when no signer is connected (offline) -- same as legacy.
  async storeEncryptedKey(keyId: string, key: Uint8Array, associatedId: string | null): Promise<void> {
    if (!this.db) await this.openDB()

    const keyHex = Crypto.bytesToHex(key)

    let encryptedKey: string
    try {
      if (this.auth && this.auth.isConnected) {
        encryptedKey = await this.auth.nip04Encrypt(this.userPubkey!, keyHex)
      } else {
        encryptedKey = Crypto.bytesToBase64(key)
      }
    } catch {
      console.warn('Keys: NIP-04 encryption not available, using base64 fallback')
      encryptedKey = Crypto.bytesToBase64(key)
    }

    const record: KeyRecord = {
      id: `${this.userPubkey}:${keyId}`,
      pubkey: this.userPubkey!,
      keyId,
      type: keyId.split(':')[0],
      associatedId,
      encryptedKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite')
      const store = tx.objectStore(this.STORE_NAME)
      const request = store.put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  },

  async loadEncryptedKey(keyId: string): Promise<Uint8Array | null> {
    if (!this.db) await this.openDB()

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly')
      const store = tx.objectStore(this.STORE_NAME)
      const request = store.get(`${this.userPubkey}:${keyId}`)

      request.onsuccess = async () => {
        const record = request.result as KeyRecord | undefined
        if (!record) {
          resolve(null)
          return
        }
        try {
          if (this.auth && this.auth.isConnected && record.encryptedKey.includes('?iv=')) {
            const keyHex = await this.auth.nip04Decrypt(this.userPubkey!, record.encryptedKey)
            resolve(Crypto.hexToBytes(keyHex))
          } else {
            resolve(Crypto.base64ToBytes(record.encryptedKey))
          }
        } catch (err) {
          console.error('Keys: Failed to decrypt key:', err)
          resolve(null)
        }
      }

      request.onerror = () => reject(request.error)
    })
  },

  async deleteKey(keyId: string): Promise<void> {
    if (!this.db) await this.openDB()
    this.keyCache.delete(keyId)
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readwrite')
      const store = tx.objectStore(this.STORE_NAME)
      const request = store.delete(`${this.userPubkey}:${keyId}`)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  },

  async importSharedFolderKey(
    folderId: string,
    encryptedKey: string,
    senderPubkey: string,
  ): Promise<Uint8Array> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Not connected')
    }
    const keyHex = await this.selfDecrypt(senderPubkey, encryptedKey)
    const folderKey = Crypto.hexToBytes(keyHex)
    await this.storeEncryptedKey(`folder:${folderId}`, folderKey, folderId)
    this.keyCache.set(`folder:${folderId}`, folderKey)
    console.log('Keys: Imported shared folder key for', folderId.slice(0, 8) + '...')
    return folderKey
  },

  async exportFolderKeyForSharing(folderId: string, recipientPubkey: string): Promise<string> {
    const folderKey = await this.getFolderKey(folderId)
    const keyHex = Crypto.bytesToHex(folderKey)
    if (!this.auth) throw new Error('Not connected')
    return this.selfEncrypt(recipientPubkey, keyHex)
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
    this.userPubkey = null
    console.log('Keys: Cache cleared')
  },

  async clearAllKeys(): Promise<void> {
    if (!this.db) await this.openDB()
    if (!this.userPubkey) {
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

  // Re-encrypt all keys after revocation (new root key)
  async rekey(): Promise<{ rootKey: Uint8Array; rekeyedFolders: number }> {
    console.log('Keys: Starting full re-key operation...')
    const newRootKey = Crypto.generateKey()

    const folderKeys: string[] = []
    for (const [keyId] of this.keyCache) {
      if (keyId.startsWith('folder:')) {
        folderKeys.push(keyId.replace('folder:', ''))
      }
    }

    for (const folderId of folderKeys) {
      const newFolderKey = Crypto.generateKey()
      this.keyCache.set(`folder:${folderId}`, newFolderKey)
      await this.storeEncryptedKey(`folder:${folderId}`, newFolderKey, folderId)
    }

    this.keyCache.set('root', newRootKey)
    await this.storeEncryptedKey('root', newRootKey, null)

    console.log('Keys: Re-key complete')
    return { rootKey: newRootKey, rekeyedFolders: folderKeys.length }
  },

  async hasFolderKey(folderId: string): Promise<boolean> {
    if (this.keyCache.has(`folder:${folderId}`)) {
      return true
    }
    const stored = await this.loadEncryptedKey(`folder:${folderId}`)
    return stored !== null
  },

  async getAllFolderIds(): Promise<(string | null)[]> {
    if (!this.db) await this.openDB()
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
    if (!this.db) await this.openDB()

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
      })),
    }

    const backupString = JSON.stringify(backup)
    const backupHash = await Crypto.hash(new TextEncoder().encode(backupString))
    const encryptedBackup = await this.auth.nip04Encrypt(this.userPubkey!, backupString)

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
  }): Promise<{ imported: number; total: number }> {
    if (!this.auth || !this.auth.isConnected) {
      throw new Error('Not connected')
    }
    if (backupData.pubkey !== this.userPubkey) {
      throw new Error('Backup is for a different user')
    }

    const decryptedString = await this.auth.nip04Decrypt(this.userPubkey!, backupData.encrypted)
    const backup = JSON.parse(decryptedString) as {
      createdAt: number
      keys: Array<{ keyId: string; type: string; associatedId: string | null; encryptedKey: string }>
    }

    const computedHash = await Crypto.hash(new TextEncoder().encode(decryptedString))
    if (computedHash !== backupData.hash) {
      console.warn('Keys: Backup hash mismatch (may be truncated/modified)')
    }

    let imported = 0
    for (const keyData of backup.keys) {
      try {
        const record: KeyRecord = {
          id: `${this.userPubkey}:${keyData.keyId}`,
          pubkey: this.userPubkey!,
          keyId: keyData.keyId,
          type: keyData.type,
          associatedId: keyData.associatedId,
          encryptedKey: keyData.encryptedKey,
          createdAt: backup.createdAt,
          updatedAt: Date.now(),
        }
        await new Promise<void>((resolve, reject) => {
          const tx = this.db!.transaction(this.STORE_NAME, 'readwrite')
          const store = tx.objectStore(this.STORE_NAME)
          const request = store.put(record)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
        imported++
      } catch (err) {
        console.warn(`Keys: Failed to import key ${keyData.keyId}:`, err)
      }
    }

    this.clearCache()
    this.userPubkey = backupData.pubkey

    console.log(`Keys: Imported ${imported} keys from backup`)
    return { imported, total: backup.keys.length }
  },
}

export type KeysModule = typeof Keys
export default Keys
