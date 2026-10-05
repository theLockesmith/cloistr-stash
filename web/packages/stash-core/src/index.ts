// @cloistr/stash-core: the Stash data layer with no React dependency.
//
// The web app and headless clients (CLI, plain Node) share this one copy.
// Browser code typically imports the per-module subpaths
// ('@cloistr/stash-core/keys', ...); this index adds `connect()` for
// headless callers, which wires a signer, a key store and endpoints in one
// step. Node-only modules (key-storage-file) are NOT re-exported here so the
// index stays loadable in a browser bundle; import them by subpath.

import type { SignerInterface } from '@cloistr/auth/core'
import { API } from './api'
import { Keys } from './keys'
import type { KeyStorage } from './key-storage'
import { Relay } from './relay'
import { updateAuth, type Signer } from './authBridge'

export type { SignerInterface }
export { API } from './api'
export type { ApiClient, SignedEvent, FileMetadata, FolderMetadata, ShareInfo, QuotaInfo } from './api'
export { Crypto } from './crypto'
export { Keys, KeyOverwriteRefusedError } from './keys'
export type { AuthPort, ApiPort } from './keys'
export { IndexedDBKeyStorage, InMemoryKeyStorage } from './key-storage'
export type { KeyRecord, KeyStorage } from './key-storage'
export { Events } from './events'
export { Relay } from './relay'
export type { UnsignedEvent, NostrFilter } from './relay'
export { RelayPrefs } from './relayprefs'
export { Sharing } from './sharing'
export { uploadFiles, uploadEncryptedBytes, addWrappedKeyToFolder, copyFile } from './upload'
export * as Operations from './operations'
export { updateAuth, authPort, getSigner } from './authBridge'
export type { Signer, AuthSnapshot } from './authBridge'
export { isMigrationComplete, runWrappedKeyMigration } from './migration-wrapped-keys'
export type { StashFile, StashFolder, WrappedKeyEntry } from './types'

export interface ConnectOptions {
  /** Any SignerInterface from @cloistr/auth/core (NIP-07, NIP-46, or a headless role/local-key signer). */
  signer: SignerInterface | Signer
  /** Key persistence. Browser default is IndexedDB; headless callers pass FileKeyStorage or InMemoryKeyStorage. */
  storage?: KeyStorage
  /** Stash server origin, e.g. 'https://stash.cloistr.xyz'. Browser default is same-origin (''). */
  apiBaseUrl?: string
  /** Relay URL. Default wss://relay.cloistr.xyz. */
  relayUrl?: string
}

/**
 * Wire the data layer to a signer and key store, then initialise keys for the
 * signer's pubkey (restores the root key from the server keyring if present).
 * Same path the web app takes on login (updateAuth), so headless behaviour
 * matches the UI's.
 */
export async function connect(opts: ConnectOptions): Promise<{ pubkey: string }> {
  if (opts.apiBaseUrl !== undefined) API.baseURL = opts.apiBaseUrl.replace(/\/+$/, '')
  if (opts.relayUrl !== undefined) Relay.defaultUrl = opts.relayUrl
  if (opts.storage) Keys.setStorage(opts.storage)
  const signer = opts.signer as Signer
  const pubkey = await signer.getPublicKey()
  await updateAuth(signer, { isConnected: true, pubkey })
  return { pubkey }
}

/** Drop the signer, clear cached keys and close the relay connection. */
export async function disconnect(): Promise<void> {
  await updateAuth(null, { isConnected: false, pubkey: null })
}
