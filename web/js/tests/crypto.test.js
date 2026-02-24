// Comprehensive tests for Cloistr Drive crypto operations
// Run in browser console or with a test runner

const CryptoTests = {
    passed: 0,
    failed: 0,
    results: [],

    async runAll() {
        console.log('========================================');
        console.log('Cloistr Drive Crypto Test Suite');
        console.log('========================================\n');

        this.passed = 0;
        this.failed = 0;
        this.results = [];

        // Initialize crypto first
        await Crypto.init();

        // Run test suites
        await this.testCryptoModule();
        await this.testKeysModule();
        await this.testSharingModule();
        await this.testVersioningModule();
        await this.testSearchModule();

        // Print summary
        console.log('\n========================================');
        console.log(`RESULTS: ${this.passed} passed, ${this.failed} failed`);
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

    async testCryptoModule() {
        console.log('\n--- Crypto Module Tests ---\n');

        // Test initialization
        this.assert(Crypto.initialized, 'Crypto module initializes');
        this.assert(Crypto.sodium !== null, 'libsodium is loaded');

        // Test key generation
        const key = Crypto.generateKey();
        this.assert(key instanceof Uint8Array, 'generateKey returns Uint8Array');
        this.assert(key.length === 32, 'Key is 256 bits (32 bytes)');

        // Test nonce generation
        const nonce = Crypto.generateNonce();
        this.assert(nonce instanceof Uint8Array, 'generateNonce returns Uint8Array');
        this.assert(nonce.length === 24, 'Nonce is 192 bits (24 bytes)');

        // Test encryption/decryption
        const plaintext = new TextEncoder().encode('Hello, World!');
        const encrypted = Crypto.encrypt(plaintext, key);
        this.assert(encrypted instanceof Uint8Array, 'encrypt returns Uint8Array');
        this.assert(encrypted.length > plaintext.length, 'Ciphertext is larger than plaintext');

        const decrypted = Crypto.decrypt(encrypted, key);
        this.assert(decrypted instanceof Uint8Array, 'decrypt returns Uint8Array');
        this.assert(decrypted.length === plaintext.length, 'Decrypted length matches');

        const decryptedText = new TextDecoder().decode(decrypted);
        this.assert(decryptedText === 'Hello, World!', 'Decrypted text matches original');

        // Test wrong key fails
        const wrongKey = Crypto.generateKey();
        let decryptFailed = false;
        try {
            Crypto.decrypt(encrypted, wrongKey);
        } catch (e) {
            decryptFailed = true;
        }
        this.assert(decryptFailed, 'Decryption with wrong key fails');

        // Test string encryption
        const testString = 'Test string with special chars: éèêë';
        const encStr = Crypto.encryptString(testString, key);
        const decStr = Crypto.decryptString(encStr, key);
        this.assert(decStr === testString, 'String encryption/decryption works');

        // Test JSON encryption
        const testObj = { foo: 'bar', num: 42, arr: [1, 2, 3] };
        const encJson = Crypto.encryptJSON(testObj, key);
        const decJson = Crypto.decryptJSON(encJson, key);
        this.assert(JSON.stringify(decJson) === JSON.stringify(testObj), 'JSON encryption/decryption works');

        // Test hashing
        const hashResult = await Crypto.hash(plaintext);
        this.assert(typeof hashResult === 'string', 'hash returns string');
        this.assert(hashResult.length === 64, 'Hash is 256 bits (64 hex chars)');

        // Test hex conversion
        const testBytes = new Uint8Array([0, 1, 255, 128]);
        const hex = Crypto.bytesToHex(testBytes);
        this.assert(hex === '0001ff80', 'bytesToHex works');
        const backToBytes = Crypto.hexToBytes(hex);
        this.assert(backToBytes[0] === 0 && backToBytes[1] === 1 && backToBytes[2] === 255 && backToBytes[3] === 128, 'hexToBytes works');

        // Test base64 conversion
        const b64 = Crypto.bytesToBase64(testBytes);
        this.assert(typeof b64 === 'string', 'bytesToBase64 returns string');
        const backFromB64 = Crypto.base64ToBytes(b64);
        this.assert(backFromB64[0] === 0 && backFromB64[3] === 128, 'base64ToBytes works');

        // Test base64url conversion
        const b64url = Crypto.bytesToBase64url(testBytes);
        this.assert(!b64url.includes('+') && !b64url.includes('/') && !b64url.includes('='), 'base64url is URL-safe');
        const backFromB64url = Crypto.base64urlToBytes(b64url);
        this.assert(backFromB64url[0] === 0 && backFromB64url[3] === 128, 'base64urlToBytes works');

        // Test constant time comparison
        const a = new Uint8Array([1, 2, 3, 4]);
        const b = new Uint8Array([1, 2, 3, 4]);
        const c = new Uint8Array([1, 2, 3, 5]);
        this.assert(Crypto.constantTimeEqual(a, b), 'constantTimeEqual returns true for equal arrays');
        this.assert(!Crypto.constantTimeEqual(a, c), 'constantTimeEqual returns false for different arrays');
    },

    async testKeysModule() {
        console.log('\n--- Keys Module Tests ---\n');

        // Mock pubkey for testing
        const testPubkey = 'test_pubkey_' + Date.now();
        await Keys.init(testPubkey);

        this.assert(Keys.userPubkey === testPubkey, 'Keys initializes with pubkey');
        this.assert(Keys.db !== null, 'IndexedDB opened');

        // Test root key generation
        const rootKey = await Keys.generateRootKey();
        this.assert(rootKey instanceof Uint8Array, 'Root key is Uint8Array');
        this.assert(rootKey.length === 32, 'Root key is 256 bits');

        // Test root key retrieval
        const retrievedRoot = await Keys.getRootKey();
        this.assert(Crypto.constantTimeEqual(rootKey, retrievedRoot), 'Root key can be retrieved');

        // Test folder key generation
        const folderId = 'test_folder_' + Date.now();
        const folderKey = await Keys.generateFolderKey(folderId);
        this.assert(folderKey instanceof Uint8Array, 'Folder key is Uint8Array');
        this.assert(folderKey.length === 32, 'Folder key is 256 bits');

        // Test folder key retrieval
        const retrievedFolder = await Keys.getFolderKey(folderId);
        this.assert(Crypto.constantTimeEqual(folderKey, retrievedFolder), 'Folder key can be retrieved');

        // Test file key derivation
        const fileId = 'test_file_' + Date.now();
        const fileKey1 = await Keys.deriveFileKey(folderId, fileId);
        this.assert(fileKey1 instanceof Uint8Array, 'File key is Uint8Array');
        this.assert(fileKey1.length === 32, 'File key is 256 bits');

        // Test deterministic derivation
        const fileKey2 = await Keys.deriveFileKey(folderId, fileId);
        this.assert(Crypto.constantTimeEqual(fileKey1, fileKey2), 'File key derivation is deterministic');

        // Test different file IDs produce different keys
        const fileKey3 = await Keys.deriveFileKey(folderId, 'different_file');
        this.assert(!Crypto.constantTimeEqual(fileKey1, fileKey3), 'Different files have different keys');

        // Test HKDF derivation
        const inputKey = Crypto.generateKey();
        const derived1 = await Keys.deriveKey(inputKey, 'info1', 'context');
        const derived2 = await Keys.deriveKey(inputKey, 'info2', 'context');
        this.assert(derived1 instanceof Uint8Array && derived1.length === 32, 'HKDF derivation works');
        this.assert(!Crypto.constantTimeEqual(derived1, derived2), 'Different info produces different keys');

        // Test cache clearing
        Keys.clearCache();
        this.assert(Keys.keyCache.size === 0, 'Cache clears');

        // Clean up
        await Keys.clearAllKeys();
    },

    async testSharingModule() {
        console.log('\n--- Sharing Module Tests ---\n');

        // Test public link URL parsing
        const testUrl = 'https://drive.cloistr.xyz/public/abc123#keydata123';
        const parsed = Sharing.parsePublicLink(testUrl);
        this.assert(parsed.sha256 === 'abc123', 'parsePublicLink extracts sha256');
        this.assert(parsed.key === 'keydata123', 'parsePublicLink extracts key');

        // Test expiration formatting
        const nowTs = Math.floor(Date.now() / 1000);
        this.assert(Sharing.formatExpiration(nowTs - 100) === 'Expired', 'formatExpiration shows Expired');
        this.assert(Sharing.formatExpiration(nowTs + 30).includes('s'), 'formatExpiration shows seconds');
        this.assert(Sharing.formatExpiration(nowTs + 120).includes('m'), 'formatExpiration shows minutes');
        this.assert(Sharing.formatExpiration(nowTs + 7200).includes('h'), 'formatExpiration shows hours');
        this.assert(Sharing.formatExpiration(null) === 'Never', 'formatExpiration shows Never for null');

        // Test share expiration check
        const expiredShare = { expires_at: nowTs - 100 };
        const validShare = { expires_at: nowTs + 100 };
        this.assert(Sharing.isShareExpired(expiredShare), 'isShareExpired detects expired');
        this.assert(!Sharing.isShareExpired(validShare), 'isShareExpired detects valid');
    },

    async testVersioningModule() {
        console.log('\n--- Versioning Module Tests ---\n');

        await Versioning.init();
        this.assert(Versioning.db !== null, 'Versioning DB opened');

        // Test timestamp formatting
        const ts = Math.floor(Date.now() / 1000);
        const formatted = Versioning.formatTimestamp(ts);
        this.assert(typeof formatted === 'string' && formatted.length > 0, 'formatTimestamp works');

        // Test time ago formatting
        this.assert(Versioning.formatTimeAgo(ts - 10) === 'just now', 'formatTimeAgo shows just now');
        this.assert(Versioning.formatTimeAgo(ts - 120).includes('minutes'), 'formatTimeAgo shows minutes');
        this.assert(Versioning.formatTimeAgo(ts - 7200).includes('hours'), 'formatTimeAgo shows hours');
        this.assert(Versioning.formatTimeAgo(ts - 172800).includes('days'), 'formatTimeAgo shows days');

        // Test version history retrieval (empty)
        const history = await Versioning.getVersionHistory('nonexistent_file');
        this.assert(Array.isArray(history), 'getVersionHistory returns array');
        this.assert(history.length === 0, 'Empty history for new file');
    },

    async testSearchModule() {
        console.log('\n--- Search Module Tests ---\n');

        // Test tokenization
        const text = 'The quick brown fox jumps over the lazy dog. Testing 123!';
        const tokens = Search.tokenize(text);
        this.assert(Array.isArray(tokens), 'tokenize returns array');
        this.assert(tokens.length > 0, 'tokenize produces tokens');
        this.assert(!tokens.includes('the'), 'Stop words are filtered');
        this.assert(!tokens.includes('123'), 'Numbers are filtered');

        // Test stemming
        this.assert(Search.stem('running') === 'runn', 'Stems -ing');
        this.assert(Search.stem('tested') === 'test', 'Stems -ed');
        this.assert(Search.stem('tests') === 'test', 'Stems -s');

        // Test term hashing
        const hash1 = await Search.hashTerm('test');
        const hash2 = await Search.hashTerm('test');
        const hash3 = await Search.hashTerm('different');
        this.assert(hash1 === hash2, 'Term hashing is deterministic');
        this.assert(hash1 !== hash3, 'Different terms have different hashes');
        this.assert(hash1.length === 32, 'Term hash is 32 chars');

        // Test indexable file types
        this.assert(Search.isIndexableFile({ mime_type: 'text/plain' }), 'text/plain is indexable');
        this.assert(Search.isIndexableFile({ mime_type: 'application/json' }), 'JSON is indexable');
        this.assert(!Search.isIndexableFile({ mime_type: 'image/png' }), 'images are not indexable');
    },
};

// Auto-run if in browser
if (typeof window !== 'undefined') {
    window.runCryptoTests = () => CryptoTests.runAll();
    console.log('Crypto tests loaded. Run with: runCryptoTests()');
}
