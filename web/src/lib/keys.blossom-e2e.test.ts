// Blossom round-trip E2E test: proves the headless encryption pipeline works
// through a real HTTP upload/download cycle, not just local memory.
//
// A mock HTTP server stands in for the Go Stash server. Process A encrypts
// and uploads a file; process B (fresh state, same FileKeyStorage dir)
// discovers, downloads, and decrypts it.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Keys } from './keys'
import { Crypto } from './crypto'
import { API } from './api'
import { FileKeyStorage } from './key-storage-file'
import type { AuthPort } from './keys'

// --- Mock Stash server -------------------------------------------------------

interface StoredFile {
  sha256: string
  size: number
  data: Buffer
}

function createMockServer(): { server: Server; files: Map<string, StoredFile>; port: () => number } {
  const files = new Map<string, StoredFile>()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'POST' && req.url === '/api/files') {
        const body = await collectBody(req)
        const fileData = extractFileFromMultipart(req.headers['content-type'] || '', body)
        const sha256 = createHash('sha256').update(fileData).digest('hex')
        files.set(sha256, { sha256, size: fileData.length, data: fileData })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sha256, size: fileData.length }))
        return
      }

      const dlMatch = req.url?.match(/^\/api\/files\/([a-f0-9]+)\/download$/)
      if (req.method === 'GET' && dlMatch) {
        const entry = files.get(dlMatch[1])
        if (!entry) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(entry.size),
        })
        res.end(entry.data)
        return
      }

      if (req.method === 'GET' && req.url?.startsWith('/api/files')) {
        const list = Array.from(files.values()).map((f) => ({
          sha256: f.sha256,
          size: f.size,
          encrypted: true,
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ files: list }))
        return
      }

      res.writeHead(404)
      res.end()
    } catch (err) {
      res.writeHead(500)
      res.end(String(err))
    }
  })

  return {
    server,
    files,
    port: () => (server.address() as { port: number }).port,
  }
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function extractFileFromMultipart(contentType: string, body: Buffer): Buffer {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/)
  if (!m) throw new Error('no multipart boundary in content-type')
  const boundary = (m[1] || m[2]).trim()
  const sep = Buffer.from(`--${boundary}`)

  const firstPartStart = body.indexOf(sep) + sep.length + 2
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), firstPartStart)
  if (headerEnd === -1) throw new Error('no header/body separator')
  const contentStart = headerEnd + 4
  const nextBoundary = body.indexOf(sep, contentStart)
  if (nextBoundary === -1) throw new Error('no closing boundary')
  return body.subarray(contentStart, nextBoundary - 2)
}

// --- Helpers -----------------------------------------------------------------

const TEST_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

function stubAuth(): AuthPort {
  return {
    isConnected: true,
    nip04Encrypt: async (_pk: string, pt: string) => `nip04:${pt}`,
    nip04Decrypt: async (_pk: string, ct: string) => ct.replace('nip04:', ''),
    nip44Encrypt: async (_pk: string, pt: string) => `nip44:${pt}`,
    nip44Decrypt: async (_pk: string, ct: string) => ct.replace('nip44:', ''),
    createRootKeyEvent: async () => ({}),
    publishEvent: async () => {},
  }
}

// --- Tests -------------------------------------------------------------------

describe('Blossom round-trip E2E', () => {
  let mock: ReturnType<typeof createMockServer>
  let tmpDir: string
  let origBaseURL: string

  beforeAll(async () => {
    mock = createMockServer()
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
    origBaseURL = API.baseURL
    API.baseURL = `http://127.0.0.1:${mock.port()}`
  })

  afterAll(async () => {
    API.baseURL = origBaseURL
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  })

  afterEach(async () => {
    Keys.clearCache()
    Keys.storage = null
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it('process A uploads encrypted file via server, process B downloads and decrypts', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stash-blossom-'))
    const folderId = 'folder-blossom-test'
    const fileId = 'file-blossom-test'
    const plaintext = new TextEncoder().encode('hello from process A — Blossom round-trip')

    // --- Process A: encrypt and upload ---
    await Crypto.init()
    const storageA = new FileKeyStorage(tmpDir)
    Keys.setStorage(storageA)
    Keys.configure({ auth: stubAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true
    Keys.keyCache.clear()

    const rootKey = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', rootKey, null)
    Keys.keyCache.set('root', rootKey)

    const folderKey = await Keys.deriveKey(rootKey, folderId, Keys.CONTEXT_FOLDER)
    const fileKey = await Keys.deriveKey(folderKey, fileId, Keys.CONTEXT_FILE)
    const ciphertext = await Crypto.encryptFile(plaintext, fileKey)

    const blob = new Blob([ciphertext], { type: 'application/octet-stream' })
    const uploadResult = await API.uploadFile(blob, null, 'e2e')
    const sha256 = uploadResult.sha256 as string
    expect(sha256).toBeTruthy()
    expect(mock.files.has(sha256)).toBe(true)

    // Wipe process A state
    Keys.clearCache()
    Keys.storage = null

    // --- Process B: list, download, decrypt ---
    const storageB = new FileKeyStorage(tmpDir)
    Keys.setStorage(storageB)
    Keys.configure({ auth: stubAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true

    const listing = await API.listFiles()
    const found = listing.files.find((f) => f.sha256 === sha256)
    expect(found).toBeTruthy()

    const downloadURL = API.getDownloadURL(sha256)
    const response = await fetch(downloadURL)
    expect(response.ok).toBe(true)
    const encryptedBuffer = await response.arrayBuffer()

    const loadedRoot = await Keys.loadEncryptedKey('root')
    expect(loadedRoot).not.toBeNull()
    Keys.keyCache.set('root', loadedRoot!)

    const derivedFolder = await Keys.deriveKey(loadedRoot!, folderId, Keys.CONTEXT_FOLDER)
    const derivedFile = await Keys.deriveKey(derivedFolder, fileId, Keys.CONTEXT_FILE)

    const decrypted = await Crypto.decryptFile(encryptedBuffer, derivedFile)
    expect(new TextDecoder().decode(decrypted)).toBe(
      'hello from process A — Blossom round-trip',
    )
  })

  it('large file survives chunked encryption through HTTP', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stash-blossom-large-'))
    const fileId = 'file-large-test'

    await Crypto.init()
    const storage = new FileKeyStorage(tmpDir)
    Keys.setStorage(storage)
    Keys.configure({ auth: stubAuth() })
    Keys.userPubkey = TEST_PUBKEY
    Keys.nip44Writes = true
    Keys.keyCache.clear()

    const rootKey = Crypto.generateKey()
    await Keys.storeEncryptedKey('root', rootKey, null)
    Keys.keyCache.set('root', rootKey)

    // 256 KiB of patterned data (crosses the chunked-encryption boundary)
    const plaintext = new Uint8Array(256 * 1024)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 251

    const fileKey = await Keys.deriveRootFileKey(fileId)
    const ciphertext = await Crypto.encryptFile(plaintext, fileKey)

    const blob = new Blob([ciphertext], { type: 'application/octet-stream' })
    const uploadResult = await API.uploadFile(blob, null, 'e2e')
    const sha256 = uploadResult.sha256 as string

    // Download and decrypt
    const response = await fetch(API.getDownloadURL(sha256))
    const downloaded = await response.arrayBuffer()
    const decrypted = await Crypto.decryptFile(downloaded, fileKey)

    expect(decrypted.length).toBe(plaintext.length)
    expect(Buffer.from(decrypted).equals(Buffer.from(plaintext))).toBe(true)
  })
})
