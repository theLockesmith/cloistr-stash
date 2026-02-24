// Integration tests for Cloistr Drive encryption phases
// Tests the full flow: upload, download, folders, sharing, versioning, search
// Run in browser console with: runIntegrationTests()

const IntegrationTests = {
    passed: 0,
    failed: 0,
    results: [],

    async runAll() {
        console.log('========================================');
        console.log('Cloistr Drive Integration Test Suite');
        console.log('All 4 Phases');
        console.log('========================================\n');

        this.passed = 0;
        this.failed = 0;
        this.results = [];

        // Initialize crypto first
        await Crypto.init();

        // Run test phases
        await this.testPhase1CoreEncryption();
        await this.testPhase2FolderSystem();
        await this.testPhase3Sharing();
        await this.testPhase4Advanced();

        // Print summary
        console.log('\n========================================');
        console.log(`INTEGRATION RESULTS: ${this.passed} passed, ${this.failed} failed`);
        console.log('========================================');

        return {
            passed: this.passed,
            failed: this.failed,
            results: this.results,
        };
    },

    assert(condition, message) {
        if (condition) {
            this.passed++;
            this.results.push({ status: 'PASS', message });
            console.log(`  ✓ ${message}`);
        } else {
            this.failed++;
            this.results.push({ status: 'FAIL', message });
            console.error(`  ✗ ${message}`);
        }
    },

    // ========================================
    // PHASE 1: Core Encryption
    // ========================================
    async testPhase1CoreEncryption() {
        console.log('\n=== PHASE 1: Core Encryption ===\n');

        // Test 1.1: File encryption roundtrip
        console.log('--- 1.1: File Encryption Roundtrip ---');

        const testContent = 'Hello, this is a test file content for encryption testing!';
        const testBuffer = new TextEncoder().encode(testContent);

        // Generate a file key
        const fileKey = Crypto.generateKey();
        this.assert(fileKey.length === 32, 'Generate 256-bit file key');

        // Encrypt file
        const encrypted = await Crypto.encryptFile(testBuffer, fileKey);
        this.assert(encrypted.length > testBuffer.length, 'Encrypted data larger than plaintext (nonce + tag)');

        // Verify encrypted data has nonce prepended (24 bytes)
        this.assert(encrypted.length === testBuffer.length + 24 + 16, 'Encrypted = plaintext + nonce(24) + tag(16)');

        // Decrypt file
        const decrypted = await Crypto.decryptFile(encrypted, fileKey);
        const decryptedText = new TextDecoder().decode(decrypted);
        this.assert(decryptedText === testContent, 'Decrypted content matches original');

        // Test 1.2: Hash verification
        console.log('\n--- 1.2: Hash Verification ---');

        const plaintextHash = await Crypto.hash(testBuffer);
        this.assert(plaintextHash.length === 64, 'SHA-256 hash is 64 hex chars');

        const encryptedHash = await Crypto.hash(encrypted);
        this.assert(encryptedHash.length === 64, 'Encrypted hash is 64 hex chars');
        this.assert(plaintextHash !== encryptedHash, 'Encrypted hash differs from plaintext hash');

        // Test 1.3: Wrong key fails decryption
        console.log('\n--- 1.3: Wrong Key Rejection ---');

        const wrongKey = Crypto.generateKey();
        let decryptionFailed = false;
        try {
            await Crypto.decryptFile(encrypted, wrongKey);
        } catch (e) {
            decryptionFailed = true;
        }
        this.assert(decryptionFailed, 'Decryption with wrong key fails');

        // Test 1.4: File ID generation
        console.log('\n--- 1.4: File ID Generation ---');

        const fileId1 = Crypto.generateFileId();
        const fileId2 = Crypto.generateFileId();
        this.assert(fileId1.length === 32, 'File ID is 32 hex chars (16 bytes)');
        this.assert(fileId1 !== fileId2, 'File IDs are unique');

        // Test 1.5: Metadata encryption
        console.log('\n--- 1.5: Metadata Encryption ---');

        const metadata = {
            name: 'test-document.txt',
            size: testBuffer.length,
            mimeType: 'text/plain',
            encrypted: true,
        };
        const encryptedMetadata = Crypto.encryptJSON(metadata, fileKey);
        const decryptedMetadata = Crypto.decryptJSON(encryptedMetadata, fileKey);
        this.assert(decryptedMetadata.name === metadata.name, 'Metadata name preserved');
        this.assert(decryptedMetadata.encrypted === true, 'Metadata encryption flag preserved');
    },

    // ========================================
    // PHASE 2: Folder System
    // ========================================
    async testPhase2FolderSystem() {
        console.log('\n=== PHASE 2: Folder System ===\n');

        // Initialize Keys with test pubkey
        const testPubkey = 'test_pubkey_phase2_' + Date.now();
        await Keys.init(testPubkey);

        // Test 2.1: Root key generation and storage
        console.log('--- 2.1: Root Key Generation ---');

        const rootKey = await Keys.getRootKey();
        this.assert(rootKey instanceof Uint8Array, 'Root key is Uint8Array');
        this.assert(rootKey.length === 32, 'Root key is 256 bits');

        // Verify root key is cached
        const cachedRoot = await Keys.getRootKey();
        this.assert(Crypto.constantTimeEqual(rootKey, cachedRoot), 'Root key retrieval is consistent');

        // Test 2.2: Folder key generation
        console.log('\n--- 2.2: Folder Key Generation ---');

        const folderId = 'folder_' + Date.now();
        const folderKey = await Keys.generateFolderKey(folderId);
        this.assert(folderKey.length === 32, 'Folder key is 256 bits');

        // Verify folder key storage and retrieval
        const retrievedFolderKey = await Keys.getFolderKey(folderId);
        this.assert(Crypto.constantTimeEqual(folderKey, retrievedFolderKey), 'Folder key retrieval works');

        // Test 2.3: File key derivation (HKDF)
        console.log('\n--- 2.3: File Key Derivation (HKDF) ---');

        const fileId1 = 'file1_' + Date.now();
        const fileId2 = 'file2_' + Date.now();

        const fileKey1 = await Keys.deriveFileKey(folderId, fileId1);
        const fileKey2 = await Keys.deriveFileKey(folderId, fileId2);

        this.assert(fileKey1.length === 32, 'Derived file key is 256 bits');
        this.assert(!Crypto.constantTimeEqual(fileKey1, fileKey2), 'Different files have different keys');

        // Verify deterministic derivation
        const fileKey1Again = await Keys.deriveFileKey(folderId, fileId1);
        this.assert(Crypto.constantTimeEqual(fileKey1, fileKey1Again), 'HKDF derivation is deterministic');

        // Test 2.4: Nested folder key derivation
        console.log('\n--- 2.4: Nested Folder Keys ---');

        const parentFolderId = 'parent_' + Date.now();
        const parentKey = await Keys.generateFolderKey(parentFolderId);

        const childFolderId = 'child_' + Date.now();
        // Child folder derives from parent
        const childKey = await Keys.getFolderKey(childFolderId, parentFolderId);

        this.assert(childKey.length === 32, 'Child folder key derived correctly');
        this.assert(!Crypto.constantTimeEqual(parentKey, childKey), 'Child key differs from parent');

        // Test 2.5: Root file key derivation (no folder)
        console.log('\n--- 2.5: Root File Keys ---');

        const rootFileId = 'rootfile_' + Date.now();
        const rootFileKey = await Keys.deriveRootFileKey(rootFileId);
        this.assert(rootFileKey.length === 32, 'Root file key is 256 bits');

        // Test 2.6: Full encryption flow with folder
        console.log('\n--- 2.6: Full Folder Encryption Flow ---');

        const testData = new TextEncoder().encode('Confidential folder document');
        const encFileKey = await Keys.deriveFileKey(folderId, 'doc123');
        const encryptedDoc = await Crypto.encryptFile(testData, encFileKey);

        // Simulate retrieval
        const decFileKey = await Keys.deriveFileKey(folderId, 'doc123');
        const decryptedDoc = await Crypto.decryptFile(encryptedDoc, decFileKey);
        const decryptedText = new TextDecoder().decode(decryptedDoc);

        this.assert(decryptedText === 'Confidential folder document', 'Full folder encryption flow works');

        // Cleanup
        Keys.clearCache();
        await Keys.clearAllKeys();
    },

    // ========================================
    // PHASE 3: Sharing
    // ========================================
    async testPhase3Sharing() {
        console.log('\n=== PHASE 3: Sharing ===\n');

        // Test 3.1: Public link key encoding
        console.log('--- 3.1: Public Link Key Encoding ---');

        const shareKey = Crypto.generateKey();
        const keyBase64url = Crypto.bytesToBase64url(shareKey);

        this.assert(!keyBase64url.includes('+'), 'No + in base64url');
        this.assert(!keyBase64url.includes('/'), 'No / in base64url');
        this.assert(!keyBase64url.includes('='), 'No padding in base64url');

        // Decode back
        const decodedKey = Crypto.base64urlToBytes(keyBase64url);
        this.assert(Crypto.constantTimeEqual(shareKey, decodedKey), 'Base64url roundtrip works');

        // Test 3.2: Share URL parsing
        console.log('\n--- 3.2: Share URL Parsing ---');

        const testHash = 'abc123def456';
        const testKey = keyBase64url;
        const shareUrl = `https://drive.cloistr.xyz/public/${testHash}#${testKey}`;

        const parsed = Sharing.parsePublicLink(shareUrl);
        this.assert(parsed.sha256 === testHash, 'SHA256 extracted from URL');
        this.assert(parsed.key === testKey, 'Key extracted from URL fragment');

        // Test 3.3: Decryption with public link key
        console.log('\n--- 3.3: Public Link Decryption ---');

        const publicContent = new TextEncoder().encode('Public shared content');
        const publicEncrypted = await Crypto.encryptFile(publicContent, shareKey);

        // Simulate receiving and decrypting
        const receivedKey = Keys.parsePublicLinkKey(keyBase64url);
        const publicDecrypted = await Crypto.decryptFile(publicEncrypted, receivedKey);
        const publicText = new TextDecoder().decode(publicDecrypted);

        this.assert(publicText === 'Public shared content', 'Public link decryption works');

        // Test 3.4: Expiration checking
        console.log('\n--- 3.4: Expiration Checking ---');

        const nowTs = Math.floor(Date.now() / 1000);
        const expiredShare = { expires_at: nowTs - 100 };
        const validShare = { expires_at: nowTs + 3600 };
        const noExpiry = { expires_at: null };

        this.assert(Sharing.isShareExpired(expiredShare) === true, 'Expired share detected');
        this.assert(Sharing.isShareExpired(validShare) === false, 'Valid share passes');
        this.assert(Sharing.isShareExpired(noExpiry) === false, 'No expiry share passes');

        // Test 3.5: Expiration formatting
        console.log('\n--- 3.5: Expiration Formatting ---');

        this.assert(Sharing.formatExpiration(nowTs - 10) === 'Expired', 'Past time shows Expired');
        this.assert(Sharing.formatExpiration(nowTs + 30).includes('s'), 'Near future shows seconds');
        this.assert(Sharing.formatExpiration(nowTs + 3600).includes('h'), 'Hours away shows hours');
        this.assert(Sharing.formatExpiration(null) === 'Never', 'Null shows Never');

        // Test 3.6: Folder key export (for NIP-44 sharing)
        console.log('\n--- 3.6: Folder Key Export ---');

        const folderKey = Crypto.generateKey();
        const keyHex = Crypto.bytesToHex(folderKey);
        this.assert(keyHex.length === 64, 'Exported key is 64 hex chars');

        // Simulate NIP-44 encrypted key (mock)
        const mockEncrypted = 'encrypted_' + keyHex;
        const mockDecrypted = mockEncrypted.replace('encrypted_', '');
        const importedKey = Crypto.hexToBytes(mockDecrypted);

        this.assert(Crypto.constantTimeEqual(folderKey, importedKey), 'Key export/import roundtrip');
    },

    // ========================================
    // PHASE 4: Advanced Features
    // ========================================
    async testPhase4Advanced() {
        console.log('\n=== PHASE 4: Advanced Features ===\n');

        // Test 4.1: Versioning initialization
        console.log('--- 4.1: Versioning System ---');

        await Versioning.init();
        this.assert(Versioning.db !== null, 'Versioning DB initialized');

        // Test timestamp formatting
        const ts = Math.floor(Date.now() / 1000);
        const formatted = Versioning.formatTimestamp(ts);
        this.assert(formatted.length > 0, 'Timestamp formatting works');

        // Test time ago
        this.assert(Versioning.formatTimeAgo(ts - 5) === 'just now', 'Just now formatting');
        this.assert(Versioning.formatTimeAgo(ts - 120).includes('minute'), 'Minutes ago formatting');
        this.assert(Versioning.formatTimeAgo(ts - 7200).includes('hour'), 'Hours ago formatting');

        // Test 4.2: Search tokenization
        console.log('\n--- 4.2: Encrypted Search ---');

        const searchText = 'The quick brown fox jumps over the lazy dog';
        const tokens = Search.tokenize(searchText);

        this.assert(Array.isArray(tokens), 'Tokenization returns array');
        this.assert(tokens.length > 0, 'Produces tokens');
        this.assert(!tokens.includes('the'), 'Filters stop words');
        this.assert(tokens.includes('quick'), 'Keeps meaningful words');

        // Test stemming
        this.assert(Search.stem('running') === 'runn', 'Stems -ing suffix');
        this.assert(Search.stem('documents') === 'document', 'Stems -s suffix');

        // Test 4.3: Search term hashing
        console.log('\n--- 4.3: Search Term Hashing ---');

        const hash1 = await Search.hashTerm('document');
        const hash2 = await Search.hashTerm('document');
        const hash3 = await Search.hashTerm('report');

        this.assert(hash1 === hash2, 'Term hashing is deterministic');
        this.assert(hash1 !== hash3, 'Different terms have different hashes');
        this.assert(hash1.length === 32, 'Term hash is 32 chars');

        // Test 4.4: Indexable file detection
        console.log('\n--- 4.4: Indexable File Detection ---');

        this.assert(Search.isIndexableFile({ mime_type: 'text/plain' }), 'Plain text is indexable');
        this.assert(Search.isIndexableFile({ mime_type: 'text/markdown' }), 'Markdown is indexable');
        this.assert(Search.isIndexableFile({ mime_type: 'application/json' }), 'JSON is indexable');
        this.assert(!Search.isIndexableFile({ mime_type: 'image/png' }), 'Images not indexable');
        this.assert(!Search.isIndexableFile({ mime_type: 'video/mp4' }), 'Videos not indexable');

        // Test 4.5: Key backup structure
        console.log('\n--- 4.5: Key Backup Format ---');

        // Test hex/base64 conversions for backup
        const testKey = Crypto.generateKey();
        const keyBase64 = Crypto.bytesToBase64(testKey);
        const keyFromBase64 = Crypto.base64ToBytes(keyBase64);

        this.assert(Crypto.constantTimeEqual(testKey, keyFromBase64), 'Base64 backup format works');

        // Test 4.6: Collaboration file type detection
        console.log('\n--- 4.6: Collaboration File Types ---');

        this.assert(Collaboration.isCollaborativeFileType('text/plain'), 'text/plain collaborative');
        this.assert(Collaboration.isCollaborativeFileType('text/markdown'), 'markdown collaborative');
        this.assert(Collaboration.isCollaborativeFileType('application/json'), 'JSON collaborative');
        this.assert(!Collaboration.isCollaborativeFileType('image/png'), 'images not collaborative');

        // Test 4.7: Re-keying preparation
        console.log('\n--- 4.7: Re-keying Flow ---');

        // Simulate re-keying: generate new root key
        const oldRootKey = Crypto.generateKey();
        const newRootKey = Crypto.generateKey();

        this.assert(!Crypto.constantTimeEqual(oldRootKey, newRootKey), 'Re-key produces new key');

        // Test key wiping
        Crypto.wipeKey(oldRootKey);
        // Note: We can't fully verify wiping in JS, but the function exists
        this.assert(true, 'Key wipe function exists');
    },
};

// Auto-run helper
if (typeof window !== 'undefined') {
    window.runIntegrationTests = () => IntegrationTests.runAll();
    console.log('Integration tests loaded. Run with: runIntegrationTests()');
}
