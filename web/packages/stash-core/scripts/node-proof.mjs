// Plain-Node proof for @cloistr/stash-core. Run by node-proof.sh INSIDE a
// throwaway directory where only the packed tarball (and its own deps) is
// installed. Exits non-zero on any failure.
//
// Proves: no React in the install, the package loads, a local-key signer
// plugs into connect(), keys persist through FileKeyStorage at 0600 across a
// simulated process restart, XChaCha20 file encryption round-trips under the
// HKDF key tree, and the refuse-to-overwrite rule fires.
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'

const require = createRequire(import.meta.url)
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
  console.log(`ok   ${msg}`)
}

let reactResolvable = true
try {
  require.resolve('react')
} catch {
  reactResolvable = false
}
check(!reactResolvable, 'react is NOT installed/resolvable')

const core = await import('@cloistr/stash-core')
const { FileKeyStorage } = await import('@cloistr/stash-core/key-storage-file')
const { Crypto, Keys, KeyOverwriteRefusedError, connect, disconnect } = core
check(typeof connect === 'function', 'package entry loads in plain Node')

// Minimal local-key SignerInterface (what a role/headless signer provides).
function localSigner(sk) {
  const pk = getPublicKey(sk)
  return {
    getPublicKey: async () => pk,
    signEvent: async (e) => finalizeEvent(e, sk),
    encrypt: async (to, pt) => nip04.encrypt(sk, to, pt),
    decrypt: async (from, ct) => nip04.decrypt(sk, from, ct),
    nip44Encrypt: async (to, pt) => nip44.encrypt(pt, nip44.getConversationKey(sk, to)),
    nip44Decrypt: async (from, ct) => nip44.decrypt(ct, nip44.getConversationKey(sk, from)),
  }
}

const sk = generateSecretKey()
const keyDir = join(mkdtempSync(join(tmpdir(), 'stash-core-proof-')), 'keys')
// Unroutable API so the keyring lookup fails fast and offline; this proof is
// about the library, not the network.
const opts = { signer: localSigner(sk), storage: new FileKeyStorage(keyDir), apiBaseUrl: 'http://127.0.0.1:9' }

// Keep the background wrapped-key migration offline too.
core.API.listFolders = async () => ({ folders: [] })
core.API.listFiles = async () => ({ files: [] })
core.Relay.subscribe = async () => []
core.Relay.publish = async () => {}

const { pubkey } = await connect(opts)
check(/^[0-9a-f]{64}$/.test(pubkey), 'connect() with a local-key signer')

// Capture key bytes as hex: disconnect() wipes cached key buffers in place.
const rootHex = Crypto.bytesToHex(await Keys.getRootKey())
const folderHex = Crypto.bytesToHex(await Keys.getFolderKey('proof-folder'))
const fileKey = await Keys.deriveFileKey('proof-folder', 'proof-file')
const plaintext = new TextEncoder().encode('stash-core headless round trip')
const ciphertext = await Crypto.encryptFile(plaintext, fileKey)
check(Crypto.bytesToHex(ciphertext) !== Crypto.bytesToHex(plaintext), 'file encrypted (XChaCha20-Poly1305)')

const files = readdirSync(keyDir)
check(files.length >= 2, `key records written to disk (${files.length})`)
check((statSync(keyDir).mode & 0o777) === 0o700, 'key directory is 0700')
check(files.every((f) => (statSync(join(keyDir, f)).mode & 0o777) === 0o600), 'every key record is 0600')

// Simulated restart: drop everything in memory, reconnect to the same dir.
await disconnect()
Keys.keyCache.clear()
await connect({ ...opts, storage: new FileKeyStorage(keyDir) })
const root2 = await Keys.getRootKey()
check(Crypto.bytesToHex(root2) === rootHex, 'root key restored from disk after restart')
const fileKey2 = await Keys.deriveFileKey('proof-folder', 'proof-file')
const decrypted = await Crypto.decryptFile(ciphertext, fileKey2)
check(new TextDecoder().decode(decrypted) === 'stash-core headless round trip', 'file decrypts after restart')

let refused = false
try {
  await Keys.storeEncryptedKey('folder:proof-folder', Crypto.generateKey(), 'proof-folder')
} catch (err) {
  refused = err instanceof KeyOverwriteRefusedError
}
check(refused, 'overwriting a stored key with different material is refused')
check(Crypto.bytesToHex(await Keys.loadEncryptedKey('folder:proof-folder')) === folderHex, 'stored key unchanged after refusal')

await disconnect()
console.log('PASS: @cloistr/stash-core runs in plain Node without React')
process.exit(0)
