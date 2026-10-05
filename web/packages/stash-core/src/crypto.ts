// Cryptographic operations module - XChaCha20-Poly1305 encryption with libsodium
// This is the core zero-knowledge encryption layer for Cloistr Stash.
//
// PORTED VERBATIM from legacy/js/crypto.js. The wire formats here are
// backward-compatibility critical: existing user blobs (single-shot
// nonce||ciphertext||tag, and the chunked "CLCH" container using
// crypto_secretbox) MUST decrypt identically. Do not "improve" the
// algorithms, nonce derivation, or byte layout. The only intentional change
// from the legacy module is the libsodium loading mechanism: instead of a
// vendored global + 'sodium-loaded' window event, we import the npm package
// and await sodium.ready. The cryptographic output is unchanged.

import _sodium from 'libsodium-wrappers'

type Sodium = typeof _sodium
type Bytes = Uint8Array

const KEY_LENGTH = 32 // 256 bits for XChaCha20
const NONCE_LENGTH = 24 // 192 bits for XChaCha20
const TAG_LENGTH = 16 // Poly1305 authentication tag
const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks for large file processing
const CHUNKED_THRESHOLD = 10 * 1024 * 1024 // Use chunked mode for files > 10MB

export const Crypto = {
  sodium: null as Sodium | null,
  initialized: false,

  KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  CHUNK_SIZE,
  CHUNKED_THRESHOLD,

  // Initialize libsodium (npm package; awaits its ready promise).
  async init(): Promise<boolean> {
    if (this.initialized) return true
    try {
      await _sodium.ready
      this.sodium = _sodium
      this.initialized = true
      console.log('Crypto: libsodium initialized')
      return true
    } catch (err) {
      console.error('Crypto: Failed to initialize libsodium:', err)
      throw new Error('Failed to initialize encryption library: ' + (err as Error).message)
    }
  },

  ensureInit(): void {
    if (!this.initialized || !this.sodium) {
      throw new Error('Crypto not initialized. Call Crypto.init() first.')
    }
  },

  // Generate a random 256-bit key
  generateKey(): Bytes {
    this.ensureInit()
    return this.sodium!.randombytes_buf(KEY_LENGTH)
  },

  // Generate a random nonce for XChaCha20
  generateNonce(): Bytes {
    this.ensureInit()
    return this.sodium!.randombytes_buf(NONCE_LENGTH)
  },

  // Generate a random file ID (16 bytes hex = 32 chars)
  generateFileId(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return this.bytesToHex(bytes)
  },

  // Encrypt data with XChaCha20-Poly1305
  // Returns: nonce (24 bytes) || ciphertext || tag (16 bytes)
  encrypt(plaintext: Bytes | ArrayBuffer | number[], key: Bytes | string): Bytes {
    this.ensureInit()

    const data = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext as ArrayBuffer)
    const keyBytes = key instanceof Uint8Array ? key : this.hexToBytes(key)

    if (keyBytes.length !== KEY_LENGTH) {
      throw new Error(`Invalid key length: ${keyBytes.length}, expected ${KEY_LENGTH}`)
    }

    const nonce = this.generateNonce()

    const ciphertext = this.sodium!.crypto_aead_xchacha20poly1305_ietf_encrypt(
      data,
      null, // additional data (AAD)
      null, // secret nonce (unused)
      nonce,
      keyBytes,
    )

    const result = new Uint8Array(nonce.length + ciphertext.length)
    result.set(nonce, 0)
    result.set(ciphertext, nonce.length)

    return result
  },

  // Decrypt data with XChaCha20-Poly1305
  // Input: nonce (24 bytes) || ciphertext || tag (16 bytes)
  decrypt(ciphertextWithNonce: Bytes | ArrayBuffer, key: Bytes | string): Bytes {
    this.ensureInit()

    const data =
      ciphertextWithNonce instanceof Uint8Array ? ciphertextWithNonce : new Uint8Array(ciphertextWithNonce)
    const keyBytes = key instanceof Uint8Array ? key : this.hexToBytes(key)

    if (keyBytes.length !== KEY_LENGTH) {
      throw new Error(`Invalid key length: ${keyBytes.length}, expected ${KEY_LENGTH}`)
    }

    if (data.length < NONCE_LENGTH + TAG_LENGTH) {
      throw new Error('Ciphertext too short')
    }

    const nonce = data.slice(0, NONCE_LENGTH)
    const ciphertext = data.slice(NONCE_LENGTH)

    try {
      return this.sodium!.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, // secret nonce (unused)
        ciphertext,
        null, // additional data (AAD)
        nonce,
        keyBytes,
      )
    } catch {
      throw new Error('Decryption failed: invalid key or corrupted data')
    }
  },

  // Encrypt a file (ArrayBuffer or Uint8Array). Returns encrypted blob ready for upload.
  async encryptFile(
    fileData: Bytes | ArrayBuffer,
    key: Bytes,
    onProgress: ((p: number) => void) | null = null,
  ): Promise<Bytes> {
    this.ensureInit()

    const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData)

    if (data.length > CHUNKED_THRESHOLD) {
      console.log(`Crypto: Using chunked encryption for ${this.formatSize(data.length)} file`)
      return this.encryptChunked(data, key, onProgress)
    }

    return this.encrypt(data, key)
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  },

  async decryptFile(encryptedData: Bytes | ArrayBuffer, key: Bytes): Promise<Bytes> {
    this.ensureInit()

    const data = encryptedData instanceof Uint8Array ? encryptedData : new Uint8Array(encryptedData)

    if (this.isChunkedData(data)) {
      return this.decryptChunked(data, key)
    }

    return this.decrypt(data, key)
  },

  // Magic header: "CLCH" (Cloistr Chunked)
  isChunkedData(data: Bytes): boolean {
    return (
      data.length >= 4 && data[0] === 0x43 && data[1] === 0x4c && data[2] === 0x43 && data[3] === 0x48
    )
  },

  // Encrypt large file in chunks.
  // Format: CLCH (4) | version (1) | chunk_size (4) | chunk_count (4) | base_nonce (24) | [chunks...]
  async encryptChunked(
    fileData: Bytes,
    key: Bytes,
    onProgress: ((p: number) => void) | null = null,
  ): Promise<Bytes> {
    this.ensureInit()

    const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData)
    const chunkSize = CHUNK_SIZE
    const chunkCount = Math.ceil(data.length / chunkSize)

    const baseNonce = this.generateNonce()

    const headerSize = 37
    const totalChunksSize = data.length + chunkCount * TAG_LENGTH
    const totalSize = headerSize + totalChunksSize

    const output = new Uint8Array(totalSize)
    let offset = 0

    // Magic: CLCH
    output[offset++] = 0x43 // C
    output[offset++] = 0x4c // L
    output[offset++] = 0x43 // C
    output[offset++] = 0x48 // H

    // Version: 1
    output[offset++] = 0x01

    // Chunk size (4 bytes, big-endian)
    output[offset++] = (chunkSize >> 24) & 0xff
    output[offset++] = (chunkSize >> 16) & 0xff
    output[offset++] = (chunkSize >> 8) & 0xff
    output[offset++] = chunkSize & 0xff

    // Chunk count (4 bytes, big-endian)
    output[offset++] = (chunkCount >> 24) & 0xff
    output[offset++] = (chunkCount >> 16) & 0xff
    output[offset++] = (chunkCount >> 8) & 0xff
    output[offset++] = chunkCount & 0xff

    // Base nonce
    output.set(baseNonce, offset)
    offset += NONCE_LENGTH

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, data.length)
      const chunk = data.slice(start, end)

      const chunkNonce = this.deriveChunkNonce(baseNonce, i)

      const encrypted = this.sodium!.crypto_secretbox_easy(chunk, chunkNonce, key)
      output.set(encrypted, offset)
      offset += encrypted.length

      if (onProgress) onProgress((i + 1) / chunkCount)

      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0))
    }

    return output
  },

  async decryptChunked(
    encryptedData: Bytes,
    key: Bytes,
    onProgress: ((p: number) => void) | null = null,
  ): Promise<Bytes> {
    this.ensureInit()

    let offset = 4 // Skip magic header

    const version = encryptedData[offset++]
    if (version !== 1) {
      throw new Error(`Unsupported chunk version: ${version}`)
    }

    const chunkSize =
      (encryptedData[offset] << 24) |
      (encryptedData[offset + 1] << 16) |
      (encryptedData[offset + 2] << 8) |
      encryptedData[offset + 3]
    offset += 4

    const chunkCount =
      (encryptedData[offset] << 24) |
      (encryptedData[offset + 1] << 16) |
      (encryptedData[offset + 2] << 8) |
      encryptedData[offset + 3]
    offset += 4

    const baseNonce = encryptedData.slice(offset, offset + NONCE_LENGTH)
    offset += NONCE_LENGTH

    const encryptedChunkSize = chunkSize + TAG_LENGTH
    const lastChunkEncryptedSize = encryptedData.length - offset - (chunkCount - 1) * encryptedChunkSize
    const lastChunkPlainSize = lastChunkEncryptedSize - TAG_LENGTH
    const totalPlainSize = (chunkCount - 1) * chunkSize + lastChunkPlainSize

    const output = new Uint8Array(totalPlainSize)
    let outputOffset = 0

    for (let i = 0; i < chunkCount; i++) {
      const isLastChunk = i === chunkCount - 1
      const thisEncryptedSize = isLastChunk ? lastChunkEncryptedSize : encryptedChunkSize
      const encryptedChunk = encryptedData.slice(offset, offset + thisEncryptedSize)
      offset += thisEncryptedSize

      const chunkNonce = this.deriveChunkNonce(baseNonce, i)

      const decrypted = this.sodium!.crypto_secretbox_open_easy(encryptedChunk, chunkNonce, key)
      output.set(decrypted, outputOffset)
      outputOffset += decrypted.length

      if (onProgress) onProgress((i + 1) / chunkCount)

      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0))
    }

    return output
  },

  // Derive nonce for a specific chunk (XOR base nonce's last 4 bytes with chunk index, big-endian)
  deriveChunkNonce(baseNonce: Bytes, chunkIndex: number): Bytes {
    const nonce = new Uint8Array(baseNonce)
    const indexBytes = new Uint8Array(4)
    indexBytes[0] = (chunkIndex >> 24) & 0xff
    indexBytes[1] = (chunkIndex >> 16) & 0xff
    indexBytes[2] = (chunkIndex >> 8) & 0xff
    indexBytes[3] = chunkIndex & 0xff

    nonce[20] ^= indexBytes[0]
    nonce[21] ^= indexBytes[1]
    nonce[22] ^= indexBytes[2]
    nonce[23] ^= indexBytes[3]

    return nonce
  },

  encryptString(plaintext: string, key: Bytes): Bytes {
    const encoder = new TextEncoder()
    return this.encrypt(encoder.encode(plaintext), key)
  },

  decryptString(ciphertext: Bytes, key: Bytes): string {
    const data = this.decrypt(ciphertext, key)
    return new TextDecoder().decode(data)
  },

  encryptJSON(obj: unknown, key: Bytes): Bytes {
    return this.encryptString(JSON.stringify(obj), key)
  },

  decryptJSON<T = unknown>(ciphertext: Bytes, key: Bytes): T {
    return JSON.parse(this.decryptString(ciphertext, key)) as T
  },

  // Calculate SHA-256 hash of data, returns hex string
  async hash(data: Bytes | ArrayBuffer): Promise<string> {
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data)
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer as BufferSource)
    return this.bytesToHex(new Uint8Array(hashBuffer))
  },

  async hashFile(file: Blob): Promise<string> {
    const buffer = await file.arrayBuffer()
    return this.hash(buffer)
  },

  bytesToHex(bytes: Bytes): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  },

  hexToBytes(hex: string): Bytes {
    if (hex.length % 2 !== 0) {
      throw new Error('Invalid hex string')
    }
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
    }
    return bytes
  },

  bytesToBase64(bytes: Bytes): string {
    const binary = String.fromCharCode.apply(null, Array.from(bytes))
    return btoa(binary)
  },

  base64ToBytes(base64: string): Bytes {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  },

  bytesToBase64url(bytes: Bytes): string {
    return this.bytesToBase64(bytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  },

  base64urlToBytes(base64url: string): Bytes {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
    while (base64.length % 4) {
      base64 += '='
    }
    return this.base64ToBytes(base64)
  },

  constantTimeEqual(a: Bytes, b: Bytes): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i]
    }
    return diff === 0
  },

  // Securely wipe a key from memory (best effort in JS)
  wipeKey(key: Bytes): void {
    if (key instanceof Uint8Array) {
      this.sodium?.memzero(key)
    }
  },
}

export type CryptoModule = typeof Crypto
export default Crypto
