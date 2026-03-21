// Search module - Client-side encrypted search indexing
// Implements zero-knowledge full-text search for Cloistr Drive

const Search = {
    // IndexedDB for encrypted search index
    DB_NAME: 'cloistr-drive-search',
    DB_VERSION: 1,
    STORE_TERMS: 'terms',
    STORE_DOCS: 'documents',

    // Database reference
    db: null,

    // In-memory index cache
    indexCache: new Map(),

    // Stop words to exclude from indexing
    stopWords: new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
        'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
        'the', 'to', 'was', 'were', 'will', 'with', 'the', 'this', 'but',
        'they', 'have', 'had', 'what', 'when', 'where', 'who', 'which',
    ]),

    // User's index encryption key
    indexKey: null,

    // Initialize search module
    async init(userPubkey) {
        await this.openDB();

        // Derive index encryption key from user's root key
        const rootKey = await Keys.getRootKey();
        this.indexKey = await Keys.deriveKey(rootKey, 'search-index', 'cloistr-drive-search-v1');

        console.log('Search: Initialized');
    },

    // Open IndexedDB
    async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Terms store: term -> [fileIds]
                if (!db.objectStoreNames.contains(this.STORE_TERMS)) {
                    const termsStore = db.createObjectStore(this.STORE_TERMS, { keyPath: 'termHash' });
                    termsStore.createIndex('pubkey', 'pubkey', { unique: false });
                }

                // Documents store: fileId -> metadata
                if (!db.objectStoreNames.contains(this.STORE_DOCS)) {
                    const docsStore = db.createObjectStore(this.STORE_DOCS, { keyPath: 'id' });
                    docsStore.createIndex('pubkey', 'pubkey', { unique: false });
                }
            };
        });
    },

    // Index a file's content
    async indexFile(file, content) {
        if (!this.indexKey) {
            console.warn('Search: Index key not initialized');
            return;
        }

        const fileId = file.file_id || file.fileId || file.d || file.sha256;

        // Extract text from content based on type
        let text = '';
        if (typeof content === 'string') {
            text = content;
        } else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
            // Try to decode as text
            const decoder = new TextDecoder();
            try {
                text = decoder.decode(content);
            } catch (e) {
                // Not text content, skip indexing
                console.log('Search: Cannot index non-text content');
                return;
            }
        }

        // Also index file metadata
        const metadataText = `${file.name || ''} ${file.mime_type || ''}`;
        text = `${metadataText} ${text}`;

        // Tokenize and normalize
        const terms = this.tokenize(text);

        // Calculate term frequencies
        const termFreqs = new Map();
        for (const term of terms) {
            termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
        }

        // Store document metadata (encrypted)
        await this.storeDocumentMeta(fileId, file, terms.length);

        // Store term -> document mappings (encrypted)
        for (const [term, freq] of termFreqs) {
            await this.addTermDocument(term, fileId, freq);
        }

        // Update cache
        this.indexCache.set(fileId, {
            terms: Array.from(termFreqs.keys()),
            indexed: Date.now(),
        });

        console.log(`Search: Indexed ${terms.length} terms for file ${fileId.slice(0, 8)}...`);
    },

    // Tokenize text into searchable terms
    tokenize(text) {
        if (!text) return [];

        // Convert to lowercase
        const normalized = text.toLowerCase();

        // Split into words
        const words = normalized.match(/\b\w{2,}\b/g) || [];

        // Filter stop words and short words
        const terms = words.filter(word =>
            word.length >= 2 &&
            !this.stopWords.has(word) &&
            !/^\d+$/.test(word) // Exclude pure numbers
        );

        // Stem words (simple suffix removal)
        return terms.map(term => this.stem(term));
    },

    // Simple stemmer (removes common suffixes)
    stem(word) {
        // Very basic stemming
        if (word.endsWith('ing')) return word.slice(0, -3);
        if (word.endsWith('ed')) return word.slice(0, -2);
        if (word.endsWith('es')) return word.slice(0, -2);
        if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
        if (word.endsWith('ly')) return word.slice(0, -2);
        if (word.endsWith('ment')) return word.slice(0, -4);
        if (word.endsWith('tion')) return word.slice(0, -4);
        return word;
    },

    // Hash a term for storage (privacy: don't store plaintext terms)
    async hashTerm(term) {
        const encoder = new TextEncoder();
        const data = encoder.encode(term);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Crypto.bytesToHex(new Uint8Array(hash)).slice(0, 32);
    },

    // Store encrypted document metadata
    async storeDocumentMeta(fileId, file, termCount) {
        if (!this.db) await this.openDB();

        const meta = {
            fileId: fileId,
            name: file.name,
            mimeType: file.mime_type || file.mimeType,
            size: file.size,
            sha256: file.sha256,
            termCount: termCount,
            indexedAt: Date.now(),
        };

        // Encrypt metadata
        const encrypted = Crypto.encryptJSON(meta, this.indexKey);

        const record = {
            id: `${Auth.pubkey}:${fileId}`,
            pubkey: Auth.pubkey,
            encryptedMeta: Crypto.bytesToBase64(encrypted),
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_DOCS, 'readwrite');
            const store = tx.objectStore(this.STORE_DOCS);
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    // Add term -> document mapping
    async addTermDocument(term, fileId, frequency) {
        if (!this.db) await this.openDB();

        const termHash = await this.hashTerm(term);
        const recordId = `${Auth.pubkey}:${termHash}`;

        return new Promise(async (resolve, reject) => {
            const tx = this.db.transaction(this.STORE_TERMS, 'readwrite');
            const store = tx.objectStore(this.STORE_TERMS);

            // Get existing record
            const getRequest = store.get(recordId);

            getRequest.onsuccess = async () => {
                let documents = [];

                if (getRequest.result) {
                    try {
                        // Decrypt existing documents
                        const encrypted = Crypto.base64ToBytes(getRequest.result.encryptedDocs);
                        documents = Crypto.decryptJSON(encrypted, this.indexKey);
                    } catch (decryptErr) {
                        // Index was created with different key (different browser/session)
                        // Start fresh for this term
                        console.warn('Search: Index entry decrypt failed, recreating:', decryptErr.message);
                        documents = [];
                    }
                }

                // Add or update document entry
                const existingIdx = documents.findIndex(d => d.fileId === fileId);
                if (existingIdx >= 0) {
                    documents[existingIdx].freq = frequency;
                } else {
                    documents.push({ fileId, freq: frequency });
                }

                // Encrypt and store
                const encryptedDocs = Crypto.encryptJSON(documents, this.indexKey);

                const record = {
                    termHash: recordId,
                    pubkey: Auth.pubkey,
                    encryptedDocs: Crypto.bytesToBase64(encryptedDocs),
                };

                const putRequest = store.put(record);
                putRequest.onsuccess = () => resolve();
                putRequest.onerror = () => reject(putRequest.error);
            };

            getRequest.onerror = () => reject(getRequest.error);
        });
    },

    // Search for files matching query
    async search(query, options = {}) {
        const {
            limit = 50,
            fuzzy = true,
        } = options;

        if (!this.indexKey) {
            console.warn('Search: Index key not initialized');
            return [];
        }

        // Tokenize query
        const queryTerms = this.tokenize(query);

        if (queryTerms.length === 0) {
            return [];
        }

        console.log(`Search: Searching for "${query}" (${queryTerms.length} terms)`);

        // Get documents for each term
        const termResults = await Promise.all(
            queryTerms.map(term => this.getTermDocuments(term))
        );

        // Score documents (TF-IDF-like scoring)
        const scores = new Map();

        for (let i = 0; i < queryTerms.length; i++) {
            const docs = termResults[i];
            for (const doc of docs) {
                const currentScore = scores.get(doc.fileId) || 0;
                // Simple scoring: term frequency * query term weight
                scores.set(doc.fileId, currentScore + doc.freq);
            }
        }

        // Sort by score
        const sortedResults = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);

        // Get document metadata for results
        const results = [];
        for (const [fileId, score] of sortedResults) {
            const meta = await this.getDocumentMeta(fileId);
            if (meta) {
                results.push({
                    ...meta,
                    score: score,
                });
            }
        }

        console.log(`Search: Found ${results.length} results`);

        return results;
    },

    // Get documents for a term
    async getTermDocuments(term) {
        if (!this.db) await this.openDB();

        const termHash = await this.hashTerm(term);
        const recordId = `${Auth.pubkey}:${termHash}`;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_TERMS, 'readonly');
            const store = tx.objectStore(this.STORE_TERMS);
            const request = store.get(recordId);

            request.onsuccess = () => {
                if (!request.result) {
                    resolve([]);
                    return;
                }

                try {
                    const encrypted = Crypto.base64ToBytes(request.result.encryptedDocs);
                    const documents = Crypto.decryptJSON(encrypted, this.indexKey);
                    resolve(documents);
                } catch (err) {
                    // Index was encrypted with different key - stale data, return empty
                    console.warn('Search: Term index encrypted with different key, ignoring stale entry');
                    resolve([]);
                }
            };

            request.onerror = () => {
                console.error('Search: Failed to get term documents:', request.error);
                resolve([]);
            };
        });
    },

    // Get document metadata
    async getDocumentMeta(fileId) {
        if (!this.db) await this.openDB();

        const recordId = `${Auth.pubkey}:${fileId}`;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_DOCS, 'readonly');
            const store = tx.objectStore(this.STORE_DOCS);
            const request = store.get(recordId);

            request.onsuccess = () => {
                if (!request.result) {
                    resolve(null);
                    return;
                }

                try {
                    const encrypted = Crypto.base64ToBytes(request.result.encryptedMeta);
                    const meta = Crypto.decryptJSON(encrypted, this.indexKey);
                    resolve(meta);
                } catch (err) {
                    // Index was encrypted with different key - stale data, return null
                    console.warn('Search: Doc meta encrypted with different key, ignoring stale entry');
                    resolve(null);
                }
            };

            request.onerror = () => {
                console.error('Search: Failed to get document meta:', request.error);
                resolve(null);
            };
        });
    },

    // Remove file from index
    async removeFromIndex(fileId) {
        if (!this.db) await this.openDB();

        // Get cached terms for this file
        const cached = this.indexCache.get(fileId);

        if (cached && cached.terms) {
            // Remove file from each term's document list
            for (const term of cached.terms) {
                await this.removeTermDocument(term, fileId);
            }
        }

        // Remove document metadata
        const recordId = `${Auth.pubkey}:${fileId}`;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_DOCS, 'readwrite');
            const store = tx.objectStore(this.STORE_DOCS);
            const request = store.delete(recordId);
            request.onsuccess = () => {
                this.indexCache.delete(fileId);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    },

    // Remove file from a term's document list
    async removeTermDocument(term, fileId) {
        if (!this.db) await this.openDB();

        const termHash = await this.hashTerm(term);
        const recordId = `${Auth.pubkey}:${termHash}`;

        return new Promise(async (resolve, reject) => {
            const tx = this.db.transaction(this.STORE_TERMS, 'readwrite');
            const store = tx.objectStore(this.STORE_TERMS);
            const request = store.get(recordId);

            request.onsuccess = async () => {
                if (!request.result) {
                    resolve();
                    return;
                }

                try {
                    const encrypted = Crypto.base64ToBytes(request.result.encryptedDocs);
                    let documents = Crypto.decryptJSON(encrypted, this.indexKey);

                    // Remove the file
                    documents = documents.filter(d => d.fileId !== fileId);

                    if (documents.length === 0) {
                        // Delete the term record entirely
                        const deleteRequest = store.delete(recordId);
                        deleteRequest.onsuccess = () => resolve();
                        deleteRequest.onerror = () => reject(deleteRequest.error);
                    } else {
                        // Update with remaining documents
                        const encryptedDocs = Crypto.encryptJSON(documents, this.indexKey);
                        const record = {
                            termHash: recordId,
                            pubkey: Auth.pubkey,
                            encryptedDocs: Crypto.bytesToBase64(encryptedDocs),
                        };
                        const putRequest = store.put(record);
                        putRequest.onsuccess = () => resolve();
                        putRequest.onerror = () => reject(putRequest.error);
                    }
                } catch (err) {
                    console.error('Search: Failed to update term documents:', err);
                    resolve();
                }
            };

            request.onerror = () => reject(request.error);
        });
    },

    // Rebuild entire search index
    async rebuildIndex(files) {
        console.log(`Search: Rebuilding index for ${files.length} files...`);

        // Clear existing index
        await this.clearIndex();

        // Re-index each file
        for (const file of files) {
            try {
                // Download and decrypt file content
                if (this.isIndexableFile(file)) {
                    const content = await this.getFileContent(file);
                    if (content) {
                        await this.indexFile(file, content);
                    }
                } else {
                    // Index just the metadata
                    await this.indexFile(file, '');
                }
            } catch (err) {
                console.warn(`Search: Failed to index file ${file.sha256?.slice(0, 8)}:`, err);
            }
        }

        console.log('Search: Index rebuild complete');
    },

    // Clear the entire index
    async clearIndex() {
        if (!this.db) await this.openDB();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.STORE_TERMS, this.STORE_DOCS], 'readwrite');

            tx.objectStore(this.STORE_TERMS).clear();
            tx.objectStore(this.STORE_DOCS).clear();

            tx.oncomplete = () => {
                this.indexCache.clear();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    },

    // Check if file type is indexable
    isIndexableFile(file) {
        const indexableTypes = [
            'text/',
            'application/json',
            'application/javascript',
            'application/xml',
            'application/pdf', // Would need pdf.js
        ];

        const mimeType = file.mime_type || file.mimeType || '';
        return indexableTypes.some(t => mimeType.startsWith(t));
    },

    // Get file content for indexing
    async getFileContent(file) {
        try {
            const fileId = file.file_id || file.fileId || file.d;
            const folderId = file.folder_id || file.folderId || file.folder || null;

            // Fetch encrypted file
            const downloadUrl = API.getDownloadURL(file.sha256);
            const response = await fetch(downloadUrl);

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const encryptedData = await response.arrayBuffer();

            // Check if encrypted
            if (file.encrypted) {
                let fileKey;
                if (folderId) {
                    fileKey = await Keys.deriveFileKey(folderId, fileId);
                } else {
                    fileKey = await Keys.deriveRootFileKey(fileId);
                }

                const decrypted = await Crypto.decryptFile(encryptedData, fileKey);
                Crypto.wipeKey(fileKey);

                return decrypted;
            }

            return new Uint8Array(encryptedData);
        } catch (err) {
            console.warn('Search: Failed to get file content:', err);
            return null;
        }
    },

    // Wipe index key on disconnect
    clearKey() {
        if (this.indexKey) {
            Crypto.wipeKey(this.indexKey);
            this.indexKey = null;
        }
        this.indexCache.clear();
    },

    // Get index statistics
    async getStats() {
        if (!this.db) await this.openDB();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.STORE_TERMS, this.STORE_DOCS], 'readonly');

            let termCount = 0;
            let docCount = 0;

            const termsRequest = tx.objectStore(this.STORE_TERMS).count();
            termsRequest.onsuccess = () => {
                termCount = termsRequest.result;
            };

            const docsRequest = tx.objectStore(this.STORE_DOCS).count();
            docsRequest.onsuccess = () => {
                docCount = docsRequest.result;
            };

            tx.oncomplete = () => {
                resolve({
                    termCount: termCount,
                    documentCount: docCount,
                    cacheSize: this.indexCache.size,
                });
            };

            tx.onerror = () => reject(tx.error);
        });
    },
};
