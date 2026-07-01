// Cryptographic search-index module — verbatim port of legacy/js/search.js
// to typed TypeScript ESM for the cloistr-stash React migration.
//
// BACKWARD-COMPATIBILITY ANCHORS — these identifiers are persisted user data
// and MUST remain byte-identical:
//   IndexedDB database name : 'cloistr-drive-search'
//   IndexedDB store names   : 'terms', 'documents'
//   HKDF context string     : 'cloistr-drive-search-v1'
//   Index record shape      : TermRecord { termHash, pubkey, encryptedDocs }
//                             DocRecord  { id, pubkey, encryptedMeta }
//   Document posting shape  : { fileId: string; freq: number }
//   Term hash               : SHA-256 hex, first 32 chars
//
// Structural changes from the legacy module:
//   - Legacy globals `Auth`, `Crypto`, `Keys`, `API` replaced by typed imports.
//   - `Auth.pubkey`        → `authPort.pubkey`
//   - `Crypto.*`           → imported singleton methods (unchanged signatures)
//   - `Keys.*`             → imported singleton methods (unchanged signatures)
//   - `API.getDownloadURL` → removed; `rebuildIndex` accepts an optional
//                            `getContent` callback so callers can supply
//                            decrypted file bytes without importing API here.
//   - `getFileContent`     → removed (was API+crypto glue; use `getContent` cb)

import { Crypto } from './crypto'
import { Keys } from './keys'
import { authPort } from './authBridge'

// ── Public interfaces ────────────────────────────────────────────────────────

/** In-memory cache entry per indexed file. */
export interface IndexCacheEntry {
  terms: string[]
  indexed: number
}

/** Decrypted document metadata stored per indexed file. */
export interface DocumentMeta {
  fileId: string
  name: string
  mimeType: string | undefined
  size: number | undefined
  sha256: string
  termCount: number
  indexedAt: number
}

/** A search hit — DocumentMeta plus relevance score. */
export interface SearchResult extends DocumentMeta {
  score: number
}

/** Options for `Search.search()`. */
export interface SearchOptions {
  /** Maximum results to return (default 50). */
  limit?: number
  /** Reserved for future fuzzy matching (default true, currently unused). */
  fuzzy?: boolean
}

/** Stats returned by `Search.getStats()`. */
export interface IndexStats {
  termCount: number
  documentCount: number
  cacheSize: number
}

/** Minimal file-object shape consumed by Search (union of legacy field names). */
export interface IndexableFile {
  sha256?: string
  name?: string
  mime_type?: string
  mimeType?: string
  size?: number
  encrypted?: boolean
  file_id?: string
  fileId?: string
  d?: string
  folder_id?: string
  folderId?: string
  folder?: string
}

// ── Internal (IndexedDB record types) ───────────────────────────────────────

interface TermRecord {
  termHash: string
  pubkey: string
  encryptedDocs: string // base64 of Crypto.encryptJSON(DocPosting[])
}

interface DocRecord {
  id: string
  pubkey: string
  encryptedMeta: string // base64 of Crypto.encryptJSON(DocumentMeta)
}

interface DocPosting {
  fileId: string
  freq: number
}

// ── Module ───────────────────────────────────────────────────────────────────

export const Search = {
  // ── Constants (BACKWARD-COMPAT: do not rename) ───────────────────────────

  /** @backwardCompat IndexedDB database name — changing orphans existing indexes. */
  DB_NAME: 'cloistr-drive-search' as const,
  DB_VERSION: 1 as const,
  /** @backwardCompat Object store name — keep byte-identical. */
  STORE_TERMS: 'terms' as const,
  /** @backwardCompat Object store name — keep byte-identical. */
  STORE_DOCS: 'documents' as const,

  // ── State ────────────────────────────────────────────────────────────────

  db: null as IDBDatabase | null,
  indexCache: new Map<string, IndexCacheEntry>(),
  indexKey: null as Uint8Array | null,

  // ── Stop-word list (verbatim from legacy) ───────────────────────────────

  stopWords: new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
    'the', 'to', 'was', 'were', 'will', 'with', 'the', 'this', 'but',
    'they', 'have', 'had', 'what', 'when', 'where', 'who', 'which',
  ]),

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Initialize the search module.  Call after Keys.init() has been called for
   * the same session so getRootKey() is available.  `userPubkey` is accepted
   * for API compatibility with the legacy signature but the pubkey used at
   * runtime is always read from `authPort.pubkey`.
   *
   * @backwardCompat HKDF: Keys.deriveKey(rootKey, 'search-index', 'cloistr-drive-search-v1')
   */
  async init(userPubkey: string): Promise<void> {
    void userPubkey // accepted for API compat; pubkey comes from authPort at call-time
    await this.openDB()
    const rootKey = await Keys.getRootKey()
    // BACKWARD-COMPAT: context string 'cloistr-drive-search-v1' must stay exactly this
    this.indexKey = await Keys.deriveKey(rootKey, 'search-index', 'cloistr-drive-search-v1')
    console.log('Search: Initialized')
  },

  // ── IndexedDB ────────────────────────────────────────────────────────────

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

        // BACKWARD-COMPAT: object store 'terms', keyPath 'termHash'
        if (!db.objectStoreNames.contains(this.STORE_TERMS)) {
          const termsStore = db.createObjectStore(this.STORE_TERMS, { keyPath: 'termHash' })
          termsStore.createIndex('pubkey', 'pubkey', { unique: false })
        }

        // BACKWARD-COMPAT: object store 'documents', keyPath 'id'
        if (!db.objectStoreNames.contains(this.STORE_DOCS)) {
          const docsStore = db.createObjectStore(this.STORE_DOCS, { keyPath: 'id' })
          docsStore.createIndex('pubkey', 'pubkey', { unique: false })
        }
      }
    })
  },

  // ── Indexing ─────────────────────────────────────────────────────────────

  /**
   * Index a file's content.  Pass the decrypted plaintext bytes (or an empty
   * string to index metadata only).  Call this after a successful upload or
   * during a rebuildIndex pass.
   */
  async indexFile(file: IndexableFile, content: string | Uint8Array | ArrayBuffer): Promise<void> {
    if (!this.indexKey) {
      console.warn('Search: Index key not initialized')
      return
    }

    const fileId = file.file_id ?? file.fileId ?? file.d ?? file.sha256
    if (!fileId) {
      console.warn('Search: Cannot index file without an ID')
      return
    }

    // Extract text from content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
      const decoder = new TextDecoder()
      try {
        text = decoder.decode(content)
      } catch {
        console.log('Search: Cannot index non-text content')
        return
      }
    }

    // Prepend file metadata text (verbatim from legacy)
    const metadataText = `${file.name ?? ''} ${file.mime_type ?? ''}`
    text = `${metadataText} ${text}`

    const terms = this.tokenize(text)

    // Calculate term frequencies
    const termFreqs = new Map<string, number>()
    for (const term of terms) {
      termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1)
    }

    await this.storeDocumentMeta(fileId, file, terms.length)

    for (const [term, freq] of termFreqs) {
      await this.addTermDocument(term, fileId, freq)
    }

    this.indexCache.set(fileId, {
      terms: Array.from(termFreqs.keys()),
      indexed: Date.now(),
    })

    console.log(`Search: Indexed ${terms.length} terms for file ${fileId.slice(0, 8)}...`)
  },

  // ── Text processing (verbatim from legacy) ───────────────────────────────

  tokenize(text: string): string[] {
    if (!text) return []

    const normalized = text.toLowerCase()
    const words = normalized.match(/\b\w{2,}\b/g) ?? []

    const terms = words.filter(
      (word) =>
        word.length >= 2 &&
        !this.stopWords.has(word) &&
        !/^\d+$/.test(word), // exclude pure numbers
    )

    return terms.map((term) => this.stem(term))
  },

  stem(word: string): string {
    if (word.endsWith('ing')) return word.slice(0, -3)
    if (word.endsWith('ed')) return word.slice(0, -2)
    if (word.endsWith('es')) return word.slice(0, -2)
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
    if (word.endsWith('ly')) return word.slice(0, -2)
    if (word.endsWith('ment')) return word.slice(0, -4)
    if (word.endsWith('tion')) return word.slice(0, -4)
    return word
  },

  /** Hash a term to 32-char hex for privacy (don't store plaintext terms in IDB). */
  async hashTerm(term: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(term)
    const hash = await crypto.subtle.digest('SHA-256', data as BufferSource)
    return Crypto.bytesToHex(new Uint8Array(hash)).slice(0, 32)
  },

  // ── Low-level IDB write helpers ──────────────────────────────────────────

  async storeDocumentMeta(
    fileId: string,
    file: IndexableFile,
    termCount: number,
  ): Promise<void> {
    if (!this.db) await this.openDB()
    if (!this.indexKey) throw new Error('Search: index key not initialized')

    const pubkey = authPort.pubkey ?? ''
    const indexKey = this.indexKey
    const db = this.db!

    const meta: DocumentMeta = {
      fileId,
      name: file.name ?? '',
      mimeType: file.mime_type ?? file.mimeType,
      size: file.size,
      sha256: file.sha256 ?? '',
      termCount,
      indexedAt: Date.now(),
    }

    const encrypted = Crypto.encryptJSON(meta, indexKey)

    const record: DocRecord = {
      id: `${pubkey}:${fileId}`,
      pubkey,
      encryptedMeta: Crypto.bytesToBase64(encrypted),
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_DOCS, 'readwrite')
      const store = tx.objectStore(this.STORE_DOCS)
      const request = store.put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  },

  async addTermDocument(term: string, fileId: string, frequency: number): Promise<void> {
    if (!this.db) await this.openDB()
    if (!this.indexKey) throw new Error('Search: index key not initialized')

    const pubkey = authPort.pubkey ?? ''
    const termHash = await this.hashTerm(term)
    const recordId = `${pubkey}:${termHash}`
    const indexKey = this.indexKey
    const db = this.db!

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_TERMS, 'readwrite')
      const store = tx.objectStore(this.STORE_TERMS)
      const getRequest = store.get(recordId)

      getRequest.onsuccess = () => {
        let documents: DocPosting[] = []

        if (getRequest.result) {
          try {
            const encrypted = Crypto.base64ToBytes(
              (getRequest.result as TermRecord).encryptedDocs,
            )
            documents = Crypto.decryptJSON<DocPosting[]>(encrypted, indexKey)
          } catch (decryptErr) {
            // Index entry was created with a different key (e.g. different
            // device/session).  Start fresh for this term.
            console.warn(
              'Search: Index entry decrypt failed, recreating:',
              (decryptErr as Error).message,
            )
            documents = []
          }
        }

        // Add or update document posting
        const existingIdx = documents.findIndex((d) => d.fileId === fileId)
        if (existingIdx >= 0) {
          documents[existingIdx].freq = frequency
        } else {
          documents.push({ fileId, freq: frequency })
        }

        const encryptedDocs = Crypto.encryptJSON(documents, indexKey)

        const record: TermRecord = {
          termHash: recordId,
          pubkey,
          encryptedDocs: Crypto.bytesToBase64(encryptedDocs),
        }

        const putRequest = store.put(record)
        putRequest.onsuccess = () => resolve()
        putRequest.onerror = () => reject(putRequest.error)
      }

      getRequest.onerror = () => reject(getRequest.error)
    })
  },

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Search the encrypted index.  Returns results sorted by TF-based relevance
   * score (highest first), limited to `options.limit` (default 50).
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 50 } = options

    if (!this.indexKey) {
      console.warn('Search: Index key not initialized')
      return []
    }

    const queryTerms = this.tokenize(query)
    if (queryTerms.length === 0) return []

    console.log(`Search: Searching for "${query}" (${queryTerms.length} terms)`)

    // Fetch postings for each query term in parallel
    const termResults = await Promise.all(
      queryTerms.map((term) => this.getTermDocuments(term)),
    )

    // Score documents — simple sum of term frequencies (TF-like)
    const scores = new Map<string, number>()
    for (const docs of termResults) {
      for (const doc of docs) {
        scores.set(doc.fileId, (scores.get(doc.fileId) ?? 0) + doc.freq)
      }
    }

    const sortedResults = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)

    const results: SearchResult[] = []
    for (const [fileId, score] of sortedResults) {
      const meta = await this.getDocumentMeta(fileId)
      if (meta) {
        results.push({ ...meta, score })
      }
    }

    console.log(`Search: Found ${results.length} results`)
    return results
  },

  // ── Low-level IDB read helpers ───────────────────────────────────────────

  async getTermDocuments(term: string): Promise<DocPosting[]> {
    if (!this.db) await this.openDB()
    if (!this.indexKey) return []

    const pubkey = authPort.pubkey ?? ''
    const termHash = await this.hashTerm(term)
    const recordId = `${pubkey}:${termHash}`
    const indexKey = this.indexKey
    const db = this.db!

    return new Promise((resolve) => {
      const tx = db.transaction(this.STORE_TERMS, 'readonly')
      const store = tx.objectStore(this.STORE_TERMS)
      const request = store.get(recordId)

      request.onsuccess = () => {
        if (!request.result) {
          resolve([])
          return
        }
        try {
          const encrypted = Crypto.base64ToBytes(
            (request.result as TermRecord).encryptedDocs,
          )
          const documents = Crypto.decryptJSON<DocPosting[]>(encrypted, indexKey)
          resolve(documents)
        } catch {
          // Stale entry encrypted with a different key — skip silently
          console.warn('Search: Term index encrypted with different key, ignoring stale entry')
          resolve([])
        }
      }

      request.onerror = () => {
        console.error('Search: Failed to get term documents:', request.error)
        resolve([])
      }
    })
  },

  async getDocumentMeta(fileId: string): Promise<DocumentMeta | null> {
    if (!this.db) await this.openDB()
    if (!this.indexKey) return null

    const pubkey = authPort.pubkey ?? ''
    const recordId = `${pubkey}:${fileId}`
    const indexKey = this.indexKey
    const db = this.db!

    return new Promise((resolve) => {
      const tx = db.transaction(this.STORE_DOCS, 'readonly')
      const store = tx.objectStore(this.STORE_DOCS)
      const request = store.get(recordId)

      request.onsuccess = () => {
        if (!request.result) {
          resolve(null)
          return
        }
        try {
          const encrypted = Crypto.base64ToBytes(
            (request.result as DocRecord).encryptedMeta,
          )
          const meta = Crypto.decryptJSON<DocumentMeta>(encrypted, indexKey)
          resolve(meta)
        } catch {
          // Stale entry encrypted with a different key — skip silently
          console.warn('Search: Doc meta encrypted with different key, ignoring stale entry')
          resolve(null)
        }
      }

      request.onerror = () => {
        console.error('Search: Failed to get document meta:', request.error)
        resolve(null)
      }
    })
  },

  // ── Removal ──────────────────────────────────────────────────────────────

  /** Remove a file from the search index (terms + document record). */
  async removeFromIndex(fileId: string): Promise<void> {
    if (!this.db) await this.openDB()

    // Remove from each term's posting list using cached term list
    const cached = this.indexCache.get(fileId)
    if (cached?.terms) {
      for (const term of cached.terms) {
        await this.removeTermDocument(term, fileId)
      }
    }

    const pubkey = authPort.pubkey ?? ''
    const recordId = `${pubkey}:${fileId}`
    const db = this.db!
    const indexCache = this.indexCache

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_DOCS, 'readwrite')
      const store = tx.objectStore(this.STORE_DOCS)
      const request = store.delete(recordId)
      request.onsuccess = () => {
        indexCache.delete(fileId)
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  },

  async removeTermDocument(term: string, fileId: string): Promise<void> {
    if (!this.db) await this.openDB()
    if (!this.indexKey) return

    const pubkey = authPort.pubkey ?? ''
    const termHash = await this.hashTerm(term)
    const recordId = `${pubkey}:${termHash}`
    const indexKey = this.indexKey
    const db = this.db!

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_TERMS, 'readwrite')
      const store = tx.objectStore(this.STORE_TERMS)
      const request = store.get(recordId)

      request.onsuccess = () => {
        if (!request.result) {
          resolve()
          return
        }

        try {
          const encrypted = Crypto.base64ToBytes(
            (request.result as TermRecord).encryptedDocs,
          )
          let documents = Crypto.decryptJSON<DocPosting[]>(encrypted, indexKey)

          documents = documents.filter((d) => d.fileId !== fileId)

          if (documents.length === 0) {
            // Delete the term record entirely
            const deleteRequest = store.delete(recordId)
            deleteRequest.onsuccess = () => resolve()
            deleteRequest.onerror = () => reject(deleteRequest.error)
          } else {
            // Update with remaining postings
            const encryptedDocs = Crypto.encryptJSON(documents, indexKey)
            const record: TermRecord = {
              termHash: recordId,
              pubkey,
              encryptedDocs: Crypto.bytesToBase64(encryptedDocs),
            }
            const putRequest = store.put(record)
            putRequest.onsuccess = () => resolve()
            putRequest.onerror = () => reject(putRequest.error)
          }
        } catch (err) {
          console.error('Search: Failed to update term documents:', err)
          resolve() // non-fatal; stale entry
        }
      }

      request.onerror = () => reject(request.error)
    })
  },

  // ── Rebuild / clear ──────────────────────────────────────────────────────

  /**
   * Rebuild the entire index from scratch.
   *
   * @param files      All files to index.
   * @param getContent Optional callback that returns decrypted file bytes for
   *                   a file.  When provided, indexable MIME types will have
   *                   their full text content indexed.  When omitted (or when
   *                   the callback returns null), only file metadata is indexed.
   *
   * Integration note: this is the hook in upload.ts after a successful upload
   * (currently a TODO comment there); call `Search.indexFile(file, plaintext)`
   * there instead of rebuilding the full index each time.
   */
  async rebuildIndex(
    files: IndexableFile[],
    getContent?: (file: IndexableFile) => Promise<Uint8Array | null>,
  ): Promise<void> {
    console.log(`Search: Rebuilding index for ${files.length} files...`)

    await this.clearIndex()

    for (const file of files) {
      try {
        if (getContent && this.isIndexableFile(file)) {
          const content = await getContent(file)
          await this.indexFile(file, content ?? '')
        } else {
          await this.indexFile(file, '')
        }
      } catch (err) {
        const id = file.sha256?.slice(0, 8) ?? '?'
        console.warn(`Search: Failed to index file ${id}:`, err)
      }
    }

    console.log('Search: Index rebuild complete')
  },

  async clearIndex(): Promise<void> {
    if (!this.db) await this.openDB()
    const db = this.db!
    const indexCache = this.indexCache

    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_TERMS, this.STORE_DOCS], 'readwrite')

      tx.objectStore(this.STORE_TERMS).clear()
      tx.objectStore(this.STORE_DOCS).clear()

      tx.oncomplete = () => {
        indexCache.clear()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    })
  },

  // ── Utilities ────────────────────────────────────────────────────────────

  isIndexableFile(file: IndexableFile): boolean {
    const indexableTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/xml',
      'application/pdf',
    ]
    const mimeType = file.mime_type ?? file.mimeType ?? ''
    return indexableTypes.some((t) => mimeType.startsWith(t))
  },

  /** Wipe the index key and clear the in-memory cache.  Call on disconnect. */
  clearKey(): void {
    if (this.indexKey) {
      Crypto.wipeKey(this.indexKey)
      this.indexKey = null
    }
    this.indexCache.clear()
  },

  async getStats(): Promise<IndexStats> {
    if (!this.db) await this.openDB()
    const db = this.db!

    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_TERMS, this.STORE_DOCS], 'readonly')

      let termCount = 0
      let docCount = 0

      const termsRequest = tx.objectStore(this.STORE_TERMS).count()
      termsRequest.onsuccess = () => {
        termCount = termsRequest.result
      }

      const docsRequest = tx.objectStore(this.STORE_DOCS).count()
      docsRequest.onsuccess = () => {
        docCount = docsRequest.result
      }

      tx.oncomplete = () => {
        resolve({ termCount, documentCount: docCount, cacheSize: this.indexCache.size })
      }
      tx.onerror = () => reject(tx.error)
    })
  },
}

export type SearchModule = typeof Search
export default Search
