// NIP-46 Remote Signer Client
// Implements Nostr Connect protocol for remote signing via bunker

const NIP46 = {
    // Connection state
    connected: false,
    userPubkey: null,
    remotePubkey: null,
    relayUrls: [],
    secret: null,

    // Client keypair (ephemeral)
    clientPrivkey: null,
    clientPubkey: null,

    // WebSocket connections (one per relay)
    sockets: [],

    // Pending requests
    pendingRequests: new Map(),
    requestId: 0,

    // Pending event publishes (waiting for OK responses)
    pendingPublishes: new Map(),

    // Track seen events to deduplicate responses from multiple relays
    seenEvents: new Set(),

    // Adaptive rate limiting and circuit breaker for relay health
    // Works WITH rate limits instead of fighting them
    relayHealth: new Map(), // url -> { failures, lastFailure, disabled, throttleMs, lastRequest }

    RELAY_CONFIG: {
        // Circuit breaker settings
        MAX_FAILURES: 5,           // Disable relay after N consecutive failures
        COOLDOWN_MS: 60000,        // Re-enable after 60 seconds

        // Throttling settings (adaptive rate limiting)
        // Keep these LOW - signer also has backoff, combined delay adds up fast
        MIN_THROTTLE_MS: 0,        // No delay when healthy
        MAX_THROTTLE_MS: 2000,     // Max 2s delay (was 5s - too aggressive with signer backoff)
        THROTTLE_INCREASE: 250,    // Add 250ms per rate-limit hit (was 500ms)
        THROTTLE_DECREASE: 100,    // Remove 100ms per success

        // Connection settings
        CONNECT_TIMEOUT_MS: 10000, // Per-relay connection timeout

        // Request timeout settings
        BASE_TIMEOUT_MS: 30000,    // Base timeout for NIP-46 requests
        THROTTLE_TIMEOUT_BUFFER: 3, // Multiply throttle by this for timeout buffer
    },

    // Calculate dynamic timeout based on current throttle state
    getDynamicTimeout() {
        let maxThrottle = 0;
        for (const [url, health] of this.relayHealth) {
            if (health.throttleMs > maxThrottle) {
                maxThrottle = health.throttleMs;
            }
        }
        // Base timeout + buffer for throttled relays
        // Account for signer-side backoff too (assume up to 10s signer delay)
        const signerBuffer = maxThrottle > 0 ? 15000 : 0;
        return this.RELAY_CONFIG.BASE_TIMEOUT_MS +
               (maxThrottle * this.RELAY_CONFIG.THROTTLE_TIMEOUT_BUFFER) +
               signerBuffer;
    },

    // Get or create relay health record
    getRelayHealth(url) {
        if (!this.relayHealth.has(url)) {
            this.relayHealth.set(url, {
                failures: 0,
                lastFailure: 0,
                disabled: false,
                throttleMs: 0,
                lastRequest: 0,
                rateLimited: false,
            });
        }
        return this.relayHealth.get(url);
    },

    // Record a relay success - reduce throttle, reset failures
    recordRelaySuccess(url) {
        const health = this.getRelayHealth(url);
        health.failures = 0;
        health.disabled = false;
        health.rateLimited = false;
        // Gradually reduce throttle on success
        health.throttleMs = Math.max(
            this.RELAY_CONFIG.MIN_THROTTLE_MS,
            health.throttleMs - this.RELAY_CONFIG.THROTTLE_DECREASE
        );
    },

    // Record rate limiting - increase throttle
    recordRelayRateLimit(url) {
        const health = this.getRelayHealth(url);
        health.rateLimited = true;
        health.lastFailure = Date.now();
        // Increase throttle to slow down requests
        health.throttleMs = Math.min(
            this.RELAY_CONFIG.MAX_THROTTLE_MS,
            health.throttleMs + this.RELAY_CONFIG.THROTTLE_INCREASE
        );
        console.warn(`NIP-46: Rate limited by ${url}, throttling to ${health.throttleMs}ms between requests`);
    },

    // Record a relay failure - may trigger circuit breaker
    recordRelayFailure(url, reason = 'unknown') {
        const health = this.getRelayHealth(url);
        health.failures++;
        health.lastFailure = Date.now();
        health.lastReason = reason;

        // Rate limit detection
        if (reason.includes('rate') || reason.includes('limit') || reason.includes('429')) {
            this.recordRelayRateLimit(url);
            return; // Rate limiting is handled separately, don't circuit-break
        }

        if (health.failures >= this.RELAY_CONFIG.MAX_FAILURES) {
            health.disabled = true;
            console.warn(`NIP-46: Circuit breaker OPEN for ${url} (${health.failures} failures: ${reason})`);
        }
    },

    // Check if relay is healthy (not disabled or cooldown expired)
    isRelayHealthy(url) {
        const health = this.getRelayHealth(url);

        if (health.disabled) {
            // Check if cooldown has expired
            if (Date.now() - health.lastFailure > this.RELAY_CONFIG.COOLDOWN_MS) {
                console.log(`NIP-46: Circuit breaker HALF-OPEN for ${url} - allowing retry`);
                health.disabled = false;
                health.failures = Math.floor(health.failures / 2);
                health.throttleMs = Math.floor(health.throttleMs / 2);
                return true;
            }
            return false;
        }

        return true;
    },

    // Wait for throttle delay if needed (respects rate limits)
    async waitForThrottle(url) {
        const health = this.getRelayHealth(url);
        if (health.throttleMs > 0) {
            const timeSinceLastRequest = Date.now() - health.lastRequest;
            const waitTime = Math.max(0, health.throttleMs - timeSinceLastRequest);
            if (waitTime > 0) {
                console.log(`NIP-46: Throttling ${url} for ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        health.lastRequest = Date.now();
    },

    // Get list of healthy relays for sending
    getHealthyRelays() {
        return this.relayUrls.filter(url => this.isRelayHealthy(url));
    },

    // Get healthy sockets sorted by throttle (prefer faster relays)
    getHealthySockets() {
        return this.sockets
            .filter(ws => {
                if (ws.readyState !== WebSocket.OPEN) return false;
                return this.isRelayHealthy(ws.url);
            })
            .sort((a, b) => {
                const healthA = this.getRelayHealth(a.url);
                const healthB = this.getRelayHealth(b.url);
                return healthA.throttleMs - healthB.throttleMs; // Prefer less-throttled relays
            });
    },

    // Parse bunker:// URL
    // Format: bunker://<remote-pubkey>?relay=<relay-url>&secret=<secret>
    parseBunkerUrl(url) {
        try {
            // Handle both bunker:// and nostrconnect:// formats
            const normalizedUrl = url.replace('nostrconnect://', 'bunker://');

            if (!normalizedUrl.startsWith('bunker://')) {
                throw new Error('Invalid bunker URL format');
            }

            const withoutProtocol = normalizedUrl.slice('bunker://'.length);
            const [pubkeyPart, queryString] = withoutProtocol.split('?');

            if (!pubkeyPart || pubkeyPart.length !== 64) {
                throw new Error('Invalid remote pubkey in bunker URL');
            }

            const params = new URLSearchParams(queryString || '');
            const relays = params.getAll('relay');
            const secret = params.get('secret');

            if (relays.length === 0) {
                throw new Error('Missing relay parameter in bunker URL');
            }

            return {
                remotePubkey: pubkeyPart,
                relayUrls: relays,
                secret: secret || '',
            };
        } catch (err) {
            throw new Error(`Failed to parse bunker URL: ${err.message}`);
        }
    },

    // Generate random bytes
    randomBytes(length) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return bytes;
    },

    // Convert bytes to hex
    bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // Convert hex to bytes
    hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    },

    // Wait for secp256k1 library to load
    async waitForSecp256k1() {
        if (typeof nobleSecp256k1 !== 'undefined' && typeof nobleSchnorr !== 'undefined') {
            return;
        }

        return new Promise((resolve, reject) => {
            const onLoaded = () => {
                cleanup();
                resolve();
            };
            const onError = (e) => {
                cleanup();
                reject(new Error(`Failed to load secp256k1: ${e.detail || 'unknown error'}`));
            };
            const onTimeout = () => {
                cleanup();
                // Check one more time in case it loaded during timeout
                if (typeof nobleSecp256k1 !== 'undefined' && typeof nobleSchnorr !== 'undefined') {
                    resolve();
                } else {
                    reject(new Error('secp256k1 library load timeout - check network connection'));
                }
            };
            const cleanup = () => {
                window.removeEventListener('secp256k1-loaded', onLoaded);
                window.removeEventListener('secp256k1-error', onError);
            };

            window.addEventListener('secp256k1-loaded', onLoaded, { once: true });
            window.addEventListener('secp256k1-error', onError, { once: true });
            // Timeout after 15 seconds (increased for slow networks)
            setTimeout(onTimeout, 15000);
        });
    },

    // Generate ephemeral client keypair
    async generateClientKeypair() {
        await this.waitForSecp256k1();

        if (typeof nobleSchnorr === 'undefined') {
            throw new Error('secp256k1/schnorr library not loaded');
        }

        // Generate 32 random bytes for private key
        const privkeyBytes = this.randomBytes(32);
        this.clientPrivkey = this.bytesToHex(privkeyBytes);

        // Derive x-only public key using Schnorr (BIP-340) for Nostr
        const pubkeyBytes = nobleSchnorr.getPublicKey(privkeyBytes);
        this.clientPubkey = this.bytesToHex(pubkeyBytes);
    },

    // Compute shared secret for NIP-04 encryption
    async computeSharedSecret(theirPubkey) {
        await this.waitForSecp256k1();

        if (typeof nobleSecp256k1 === 'undefined') {
            throw new Error('secp256k1 library not loaded');
        }

        // Add 02 prefix for compressed pubkey (assume even y-coordinate)
        const theirPubkeyBytes = this.hexToBytes('02' + theirPubkey);
        const privkeyBytes = this.hexToBytes(this.clientPrivkey);

        // getSharedSecret returns the full point (33 bytes compressed)
        const sharedPoint = nobleSecp256k1.getSharedSecret(privkeyBytes, theirPubkeyBytes);

        // Use x-coordinate as shared secret (skip first byte which is prefix)
        return sharedPoint.slice(1, 33);
    },

    // NIP-04 encrypt
    async nip04Encrypt(plaintext, theirPubkey) {
        const sharedSecret = await this.computeSharedSecret(theirPubkey);

        // Import shared secret as AES key
        const key = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            { name: 'AES-CBC' },
            false,
            ['encrypt']
        );

        // Generate random IV
        const iv = this.randomBytes(16);

        // Encrypt
        const encoder = new TextEncoder();
        const data = encoder.encode(plaintext);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-CBC', iv },
            key,
            data
        );

        // Format: base64(ciphertext)?iv=base64(iv)
        const ciphertextB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
        const ivB64 = btoa(String.fromCharCode(...iv));

        return `${ciphertextB64}?iv=${ivB64}`;
    },

    // NIP-04 decrypt
    async nip04Decrypt(encrypted, theirPubkey) {
        const sharedSecret = await this.computeSharedSecret(theirPubkey);

        // Parse format: base64(ciphertext)?iv=base64(iv)
        const [ciphertextB64, ivPart] = encrypted.split('?iv=');
        if (!ivPart) {
            throw new Error('Invalid encrypted format');
        }

        const ciphertext = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
        const iv = Uint8Array.from(atob(ivPart), c => c.charCodeAt(0));

        // Import shared secret as AES key
        const key = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            { name: 'AES-CBC' },
            false,
            ['decrypt']
        );

        // Decrypt
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv },
            key,
            ciphertext
        );

        const decoder = new TextDecoder();
        return decoder.decode(plaintext);
    },

    // NIP-44 conversation key derivation
    // Uses ECDH shared secret + HKDF with "nip44-v2" salt
    async nip44ConversationKey(theirPubkey) {
        const sharedPoint = await this.computeSharedSecret(theirPubkey);

        // HKDF extract and expand with salt "nip44-v2"
        const salt = new TextEncoder().encode('nip44-v2');

        // Import shared point as key material for HKDF
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            sharedPoint,
            { name: 'HKDF' },
            false,
            ['deriveBits']
        );

        // Derive 32-byte conversation key
        const conversationKeyBits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: salt,
                info: new Uint8Array(0),
            },
            keyMaterial,
            256
        );

        return new Uint8Array(conversationKeyBits);
    },

    // NIP-44 encrypt using ChaCha20-Poly1305
    async nip44Encrypt(plaintext, theirPubkey) {
        // Wait for libsodium
        if (typeof sodium === 'undefined') {
            throw new Error('libsodium not loaded');
        }
        await sodium.ready;

        const conversationKey = await this.nip44ConversationKey(theirPubkey);

        // Encode plaintext
        const encoder = new TextEncoder();
        const plaintextBytes = encoder.encode(plaintext);

        // Calculate padded length (NIP-44 padding)
        const unpaddedLen = plaintextBytes.length;
        const paddedLen = this.nip44CalcPaddedLen(unpaddedLen);

        // Create padded plaintext: 2-byte big-endian length + plaintext + padding
        const padded = new Uint8Array(2 + paddedLen);
        padded[0] = (unpaddedLen >> 8) & 0xff;
        padded[1] = unpaddedLen & 0xff;
        padded.set(plaintextBytes, 2);
        // Rest is already zeros (padding)

        // Generate 32-byte nonce
        const nonce = this.randomBytes(32);

        // Derive message key using HKDF
        const nonceKey = await crypto.subtle.importKey(
            'raw',
            conversationKey,
            { name: 'HKDF' },
            false,
            ['deriveBits']
        );

        const messageKeyBits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: nonce,
                info: new TextEncoder().encode('nip44-v2'),
            },
            nonceKey,
            256
        );
        const messageKey = new Uint8Array(messageKeyBits);

        // Encrypt with ChaCha20-Poly1305 (use first 12 bytes of nonce as IETF nonce)
        const chachaNonce = nonce.slice(0, 12);
        const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
            padded,
            null, // no additional data
            null, // no secret nonce
            chachaNonce,
            messageKey
        );

        // Format: version (1) + nonce (32) + ciphertext
        const result = new Uint8Array(1 + 32 + ciphertext.length);
        result[0] = 0x02; // NIP-44 version 2
        result.set(nonce, 1);
        result.set(ciphertext, 33);

        // Return as base64
        return btoa(String.fromCharCode(...result));
    },

    // NIP-44 decrypt
    async nip44Decrypt(encrypted, theirPubkey) {
        // Wait for libsodium
        if (typeof sodium === 'undefined') {
            throw new Error('libsodium not loaded');
        }
        await sodium.ready;

        // Decode base64
        const data = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));

        // Check version
        if (data[0] !== 0x02) {
            throw new Error(`Unsupported NIP-44 version: ${data[0]}`);
        }

        // Extract nonce and ciphertext
        const nonce = data.slice(1, 33);
        const ciphertext = data.slice(33);

        const conversationKey = await this.nip44ConversationKey(theirPubkey);

        // Derive message key using HKDF
        const nonceKey = await crypto.subtle.importKey(
            'raw',
            conversationKey,
            { name: 'HKDF' },
            false,
            ['deriveBits']
        );

        const messageKeyBits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: nonce,
                info: new TextEncoder().encode('nip44-v2'),
            },
            nonceKey,
            256
        );
        const messageKey = new Uint8Array(messageKeyBits);

        // Decrypt with ChaCha20-Poly1305
        const chachaNonce = nonce.slice(0, 12);
        let padded;
        try {
            padded = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
                null, // no secret nonce
                ciphertext,
                null, // no additional data
                chachaNonce,
                messageKey
            );
        } catch (err) {
            throw new Error('NIP-44 decryption failed: invalid key or corrupted data');
        }

        // Extract plaintext length and remove padding
        const plaintextLen = (padded[0] << 8) | padded[1];
        if (plaintextLen > padded.length - 2) {
            throw new Error('Invalid NIP-44 padding');
        }

        const plaintextBytes = padded.slice(2, 2 + plaintextLen);
        const decoder = new TextDecoder();
        return decoder.decode(plaintextBytes);
    },

    // NIP-44 padding calculation
    nip44CalcPaddedLen(unpaddedLen) {
        if (unpaddedLen <= 32) return 32;
        const nextPower = Math.ceil(Math.log2(unpaddedLen));
        const chunk = Math.max(32, Math.pow(2, nextPower - 1));
        return chunk * Math.ceil(unpaddedLen / chunk);
    },

    // Detect encryption type and decrypt accordingly
    async decrypt(encrypted, theirPubkey) {
        console.log('NIP-46: decrypt() called, encrypted length:', encrypted?.length, 'has ?iv=:', encrypted?.includes('?iv='));
        // NIP-04 format contains "?iv="
        if (encrypted.includes('?iv=')) {
            console.log('NIP-46: Using NIP-04 decryption');
            const result = await this.nip04Decrypt(encrypted, theirPubkey);
            console.log('NIP-46: NIP-04 decrypt result length:', result?.length, 'starts with:', result?.substring(0, 50));
            return result;
        }

        // Otherwise assume NIP-44 (base64 blob starting with version byte)
        try {
            console.log('NIP-46: Trying NIP-44 decryption');
            return await this.nip44Decrypt(encrypted, theirPubkey);
        } catch (err) {
            console.error('NIP-44 decrypt failed, trying NIP-04:', err.message);
            // Last resort: try NIP-04 anyway
            return this.nip04Decrypt(encrypted, theirPubkey);
        }
    },

    // Encrypt using NIP-44 (preferred) with NIP-04 fallback
    async encrypt(plaintext, theirPubkey) {
        try {
            return await this.nip44Encrypt(plaintext, theirPubkey);
        } catch (err) {
            console.warn('NIP-44 encrypt failed, falling back to NIP-04:', err.message);
            return this.nip04Encrypt(plaintext, theirPubkey);
        }
    },

    // Connect to a single relay via WebSocket with circuit breaker
    connectSingleRelay(url) {
        // Check circuit breaker before attempting connection
        if (!this.isRelayHealthy(url)) {
            console.log(`NIP-46: Skipping unhealthy relay ${url}`);
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            let resolved = false;
            const ws = new WebSocket(url);

            // Per-relay connection timeout
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    console.warn(`NIP-46: Connection timeout for ${url}`);
                    this.recordRelayFailure(url, 'connection_timeout');
                    ws.close();
                    resolve(null);
                }
            }, this.RELAY_CONFIG.CONNECT_TIMEOUT_MS);

            ws.onopen = () => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                console.log('NIP-46: Connected to', url);
                this.recordRelaySuccess(url);
                resolve(ws);
            };

            ws.onerror = (err) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                console.error('NIP-46: Connection failed to', url);
                this.recordRelayFailure(url, 'connection_error');
                resolve(null); // Don't reject, allow other relays to work
            };

            ws.onclose = (event) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    // Close before open = connection rejected (e.g., 503)
                    const reason = event.code === 1006 ? 'connection_refused' : `close_${event.code}`;
                    console.warn(`NIP-46: Connection closed for ${url} (code: ${event.code})`);
                    this.recordRelayFailure(url, reason);
                    resolve(null);
                } else {
                    console.log('NIP-46: Disconnected from', url);
                }
                this.sockets = this.sockets.filter(s => s !== ws);
            };

            ws.onmessage = (msg) => {
                this.handleRelayMessage(msg.data, url);
            };
        });
    },

    // Connect to all relays (filters unhealthy ones)
    async connectRelays(urls) {
        const healthyUrls = urls.filter(url => this.isRelayHealthy(url));

        if (healthyUrls.length === 0 && urls.length > 0) {
            // All relays are unhealthy - reset circuit breakers and try again
            console.warn('NIP-46: All relays unhealthy, resetting circuit breakers');
            urls.forEach(url => this.relayHealth.delete(url));
        }

        const connections = await Promise.all(urls.map(url => this.connectSingleRelay(url)));
        this.sockets = connections.filter(ws => ws !== null);

        if (this.sockets.length === 0) {
            throw new Error('Failed to connect to any relay');
        }

        console.log('NIP-46: Connected to', this.sockets.length, 'relay(s)');
    },

    // NIP-42 authentication state
    authenticated: false,
    pendingAuth: null,
    pendingRetry: null,

    // Handle NIP-42 AUTH challenge
    async handleAuthChallenge(challenge, relayUrl, ws) {
        console.log('NIP-46: AUTH challenge received:', challenge.slice(0, 16) + '...');

        // If we have a user pubkey (from remote signer), use that for auth
        // so published events will match the authenticated identity
        if (this.userPubkey && this.connected) {
            console.log('NIP-46: Using remote signer for AUTH with user pubkey');
            try {
                // Create unsigned auth event with user's pubkey
                const authEvent = {
                    kind: 22242,
                    pubkey: this.userPubkey,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['relay', relayUrl],
                        ['challenge', challenge],
                    ],
                    content: '',
                };

                // Have the remote signer sign it
                const signedEvent = await this.signEvent(authEvent);
                console.log('NIP-46: Remote signer signed AUTH event:', signedEvent.id?.slice(0, 16) + '...');

                // Send AUTH
                ws.send(JSON.stringify(['AUTH', signedEvent]));
                this.pendingAuth = signedEvent.id;
                return;
            } catch (err) {
                console.warn('NIP-46: Remote signer AUTH failed, falling back to client key:', err.message);
            }
        }

        // Fallback: use client keypair for initial connection (before user pubkey is known)
        console.log('NIP-46: Using client keypair for AUTH (user pubkey not yet available)');
        const authEvent = {
            kind: 22242,
            pubkey: this.clientPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['relay', relayUrl],
                ['challenge', challenge],
            ],
            content: '',
        };

        // Sign the auth event with client key
        await this.waitForSecp256k1();

        const serialized = JSON.stringify([
            0,
            authEvent.pubkey,
            authEvent.created_at,
            authEvent.kind,
            authEvent.tags,
            authEvent.content,
        ]);

        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
        authEvent.id = this.bytesToHex(new Uint8Array(hashBuffer));

        const privkeyBytes = this.hexToBytes(this.clientPrivkey);
        const msgBytes = this.hexToBytes(authEvent.id);
        const sig = nobleSchnorr.sign(msgBytes, privkeyBytes);
        authEvent.sig = this.bytesToHex(sig);

        console.log('NIP-46: Sending AUTH response:', authEvent.id.slice(0, 16) + '...');

        // Send AUTH
        ws.send(JSON.stringify(['AUTH', authEvent]));

        // Store the auth event ID to track response
        this.pendingAuth = authEvent.id;
    },

    // Re-authenticate with all connected relays using the user's pubkey
    // This is called after we get the user pubkey from the remote signer
    // This is non-blocking - runs in background and doesn't block login
    async reAuthenticateWithUserPubkey() {
        if (!this.userPubkey || !this.connected) {
            console.log('NIP-46: Cannot re-authenticate - not fully connected');
            return;
        }

        console.log('NIP-46: Starting background re-authentication with user pubkey:', this.userPubkey.slice(0, 16) + '...');

        // Run in background - don't block login
        this._reAuthInBackground().catch(err => {
            console.warn('NIP-46: Background re-auth failed:', err.message);
        });
    },

    // Internal: performs the actual re-authentication (called asynchronously)
    async _reAuthInBackground() {
        for (const ws of this.sockets) {
            if (ws.readyState !== WebSocket.OPEN) continue;

            try {
                // Create auth event with user's pubkey
                const authEvent = {
                    kind: 22242,
                    pubkey: this.userPubkey,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['relay', ws.url],
                        // Generate a fresh challenge (relay may accept self-challenges)
                        ['challenge', 'cloistr-reauth-' + Date.now()],
                    ],
                    content: '',
                };

                // Have the remote signer sign it (with shorter timeout)
                const signPromise = this.signEvent(authEvent);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Re-auth sign timeout')), 10000)
                );

                const signedEvent = await Promise.race([signPromise, timeoutPromise]);

                // Send AUTH
                ws.send(JSON.stringify(['AUTH', signedEvent]));
                console.log('NIP-46: Sent re-auth for relay:', ws.url);

                // Wait a moment for the auth to be processed
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.warn('NIP-46: Re-auth failed for', ws.url, err.message);
                // Continue to next relay - don't fail completely
            }
        }

        this.authenticated = true;
        console.log('NIP-46: Re-authentication complete');
    },

    // Re-authenticate and retry pending events (called when we get "restricted" error)
    async _reAuthAndRetry() {
        console.log('NIP-46: Starting re-auth and retry for', (this.pendingAuthRetries || []).length, 'events');

        // First, do the re-authentication
        await this._reAuthInBackground();

        // Then retry all pending events
        const retries = this.pendingAuthRetries || [];
        this.pendingAuthRetries = [];

        for (const retry of retries) {
            for (const ws of this.sockets) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(['EVENT', retry.event]));
                    console.log('NIP-46: Retried event after re-auth:', retry.eventId?.slice(0, 8));
                    break;
                }
            }
        }
    },

    // Handle incoming relay messages
    async handleRelayMessage(data, relayUrl = 'unknown') {
        try {
            const message = JSON.parse(data);
            console.log('NIP-46: Received message from', relayUrl, ':', message[0], message.length > 2 ? JSON.stringify(message[2]).slice(0, 100) : '');

            // Any successful message = relay is healthy
            if (relayUrl !== 'unknown') {
                this.recordRelaySuccess(relayUrl);
            }

            // Handle NIP-42 AUTH challenge
            if (message[0] === 'AUTH') {
                const challenge = message[1];
                // Find the socket that received this
                const ws = this.sockets.find(s => s.url === relayUrl && s.readyState === WebSocket.OPEN);
                if (ws) {
                    await this.handleAuthChallenge(challenge, relayUrl, ws);
                }
                return;
            }

            if (message[0] === 'EVENT') {
                const event = message[2];

                // Deduplicate events from multiple relays
                if (this.seenEvents.has(event.id)) {
                    console.log('NIP-46: Skipping duplicate event:', event.id?.slice(0, 8));
                    return;
                }
                this.seenEvents.add(event.id);

                console.log('NIP-46: EVENT kind:', event.kind, 'from:', event.pubkey?.slice(0, 16), 'id:', event.id?.slice(0, 8));

                // Check if this is a response to us (kind 24133)
                if (event.kind === 24133 && event.pubkey === this.remotePubkey) {
                    console.log('NIP-46: Decrypting response, content length:', event.content?.length);
                    console.log('NIP-46: Content starts with:', event.content?.substring(0, 50));
                    // Decrypt the content
                    const decrypted = await this.decrypt(event.content, this.remotePubkey);
                    console.log('NIP-46: Decrypted (length=' + decrypted?.length + '):', decrypted?.substring(0, 200));
                    let response;
                    try {
                        response = JSON.parse(decrypted);
                    } catch (err) {
                        console.error('NIP-46: Failed to parse decrypted response:', err.message);
                        console.error('NIP-46: Full decrypted content:', JSON.stringify(decrypted));
                        throw err;
                    }
                    console.log('NIP-46: Response id:', response.id, 'result type:', typeof response.result, 'pending ids:', [...this.pendingRequests.keys()]);

                    // Find pending request
                    const pending = this.pendingRequests.get(response.id);
                    if (pending) {
                        console.log('NIP-46: Resolving request', response.id);
                        this.pendingRequests.delete(response.id);

                        if (response.error) {
                            pending.reject(new Error(response.error));
                        } else {
                            pending.resolve(response.result);
                        }
                    } else {
                        console.log('NIP-46: No pending request for id:', response.id, '(already processed or wrong id)');
                    }
                }
            } else if (message[0] === 'OK') {
                const eventId = message[1];
                const success = message[2];
                const reason = message[3] || '';
                console.log('NIP-46: Event published:', eventId?.slice(0, 8), success ? 'accepted' : 'rejected', reason);

                // Check if this is our AUTH response
                if (this.pendingAuth && eventId === this.pendingAuth) {
                    if (success) {
                        console.log('NIP-46: Authenticated with relay');
                        this.authenticated = true;
                        // Retry pending event if any (legacy single retry)
                        if (this.pendingRetry) {
                            console.log('NIP-46: Retrying pending request after auth...');
                            const { event, ws } = this.pendingRetry;
                            this.pendingRetry = null;
                            ws.send(JSON.stringify(['EVENT', event]));
                        }
                        // Retry any pending publish events that failed with auth-required
                        if (this.pendingAuthRetries && this.pendingAuthRetries.length > 0) {
                            console.log('NIP-46: Retrying', this.pendingAuthRetries.length, 'pending publishes after auth...');
                            const retries = this.pendingAuthRetries;
                            this.pendingAuthRetries = [];
                            for (const retry of retries) {
                                // Re-send to all open sockets
                                for (const ws of this.sockets) {
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify(['EVENT', retry.event]));
                                        console.log('NIP-46: Retried event', retry.eventId?.slice(0, 8));
                                        break; // Only need to send to one relay
                                    }
                                }
                            }
                        }
                    } else {
                        console.error('NIP-46: AUTH failed:', reason);
                        // Reject any pending auth retries
                        if (this.pendingAuthRetries) {
                            for (const retry of this.pendingAuthRetries) {
                                retry.pending.reject(new Error('AUTH failed: ' + reason));
                                this.pendingPublishes.delete(retry.eventId);
                            }
                            this.pendingAuthRetries = [];
                        }
                    }
                    this.pendingAuth = null;
                } else if (reason.includes('auth-required')) {
                    // Event was rejected due to auth-required - store for retry after AUTH
                    const pending = this.pendingPublishes.get(eventId);
                    console.log('NIP-46: Event', eventId?.slice(0, 8), 'requires auth. Pending exists:', !!pending, 'Has event:', !!(pending?.event));
                    if (pending && pending.event) {
                        // Store for retry - don't reject yet
                        this.pendingAuthRetries = this.pendingAuthRetries || [];
                        this.pendingAuthRetries.push({
                            eventId: eventId,
                            event: pending.event,
                            pending: pending,
                        });
                        console.log('NIP-46: Stored event for retry. Total pending:', this.pendingAuthRetries.length);
                        // Don't delete - keep tracking until retry completes or times out
                    } else {
                        // No pending event found - this shouldn't happen with new code
                        console.error('NIP-46: Cannot retry auth-required event - pending not found or missing event data');
                        if (pending) {
                            pending.reject(new Error('auth-required but cannot retry: ' + reason));
                            this.pendingPublishes.delete(eventId);
                        }
                    }
                } else if (reason.includes('restricted') || reason.includes('authenticated identity')) {
                    // Identity mismatch - relay authenticated with client key but event has user key
                    // Need to re-authenticate with user's pubkey and retry
                    console.warn('NIP-46: Identity mismatch - triggering re-authentication');
                    const pending = this.pendingPublishes.get(eventId);
                    if (pending && pending.event && this.userPubkey) {
                        // Store for retry after re-auth
                        this.pendingAuthRetries = this.pendingAuthRetries || [];
                        this.pendingAuthRetries.push({
                            eventId: eventId,
                            event: pending.event,
                            pending: pending,
                        });

                        // Trigger re-authentication (will retry stored events when done)
                        this._reAuthAndRetry().catch(err => {
                            console.error('NIP-46: Re-auth and retry failed:', err.message);
                            // Reject all pending retries
                            for (const retry of (this.pendingAuthRetries || [])) {
                                retry.pending.reject(new Error('Re-authentication failed'));
                                this.pendingPublishes.delete(retry.eventId);
                            }
                            this.pendingAuthRetries = [];
                        });
                    } else if (pending) {
                        pending.reject(new Error('Identity mismatch: please disconnect and reconnect'));
                        this.pendingPublishes.delete(eventId);
                    }
                } else if (reason.includes('rate-limit') || reason.includes('rate limit') || reason.includes('noting too much') || reason.includes('too fast')) {
                    // Rate limited by relay - record it and retry with throttling
                    console.warn('NIP-46: Rate limited by relay:', relayUrl, reason);
                    this.recordRelayRateLimit(relayUrl);

                    const pending = this.pendingPublishes.get(eventId);
                    if (pending && pending.event) {
                        // Retry after throttle delay
                        const retryAfterThrottle = async () => {
                            const healthySockets = this.getHealthySockets();
                            if (healthySockets.length > 0) {
                                const ws = healthySockets[0]; // Use least-throttled relay
                                await this.waitForThrottle(ws.url);
                                console.log('NIP-46: Retrying rate-limited event via', ws.url);
                                ws.send(JSON.stringify(['EVENT', pending.event]));
                            } else {
                                pending.reject(new Error('Rate limited by all relays. Please wait and try again.'));
                                this.pendingPublishes.delete(eventId);
                            }
                        };
                        retryAfterThrottle().catch(err => {
                            console.error('NIP-46: Rate-limit retry failed:', err.message);
                            pending.reject(new Error('Rate limited by relay: ' + reason));
                            this.pendingPublishes.delete(eventId);
                        });
                    }
                } else {
                    // Handle pending publish confirmations
                    const pending = this.pendingPublishes.get(eventId);
                    if (pending) {
                        if (success) {
                            pending.resolve({ success: true, message: reason });
                        } else {
                            pending.reject(new Error(reason || 'Publish rejected by relay'));
                        }
                        this.pendingPublishes.delete(eventId);
                    }
                }
            } else if (message[0] === 'EOSE') {
                // End of stored events
            }
        } catch (err) {
            console.error('NIP-46: Failed to handle relay message:', err);
        }
    },

    // Subscribe to responses from remote signer on all relays
    subscribeToResponses() {
        if (this.sockets.length === 0) return;

        const subId = 'nip46-' + Date.now();
        const filter = {
            kinds: [24133],
            authors: [this.remotePubkey],
            '#p': [this.clientPubkey],
            since: Math.floor(Date.now() / 1000) - 60,
        };
        console.log('NIP-46: Subscribing with filter:', JSON.stringify(filter));

        const message = JSON.stringify(['REQ', subId, filter]);
        this.sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    },

    // Send a request to the remote signer
    async sendRequest(method, params = []) {
        // Allow 'connect' and 'get_public_key' before fully connected
        const allowedBeforeConnect = ['connect', 'get_public_key'];
        if (this.sockets.length === 0) {
            throw new Error('Not connected to any relay');
        }
        if (!this.connected && !allowedBeforeConnect.includes(method)) {
            throw new Error('Not connected to remote signer');
        }

        const id = String(++this.requestId);
        console.log('NIP-46: Sending request', method, 'with id:', id);

        // Create request payload
        const request = {
            id,
            method,
            params,
        };

        // Encrypt the request
        // Use NIP-04 for outgoing requests (compatible with all signers)
        // Responses are auto-detected (NIP-04 or NIP-44)
        const encrypted = await this.nip04Encrypt(JSON.stringify(request), this.remotePubkey);

        // Create NIP-46 event (kind 24133)
        const event = {
            kind: 24133,
            pubkey: this.clientPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', this.remotePubkey]],
            content: encrypted,
        };

        // Serialize and hash for event ID
        const serialized = JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content,
        ]);

        const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
        event.id = this.bytesToHex(new Uint8Array(hashBuffer));

        // Sign the event with Schnorr (BIP-340)
        await this.waitForSecp256k1();

        if (typeof nobleSchnorr === 'undefined') {
            throw new Error('secp256k1/schnorr library not loaded');
        }

        const privkeyBytes = this.hexToBytes(this.clientPrivkey);
        const msgBytes = this.hexToBytes(event.id);

        // Use Schnorr signature (BIP-340) for Nostr - returns 64-byte Uint8Array
        const sig = nobleSchnorr.sign(msgBytes, privkeyBytes);
        event.sig = this.bytesToHex(sig);

        // Create promise for response with dynamic timeout
        const timeout = this.getDynamicTimeout();
        const responsePromise = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            // Dynamic timeout based on relay throttle state
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    const throttleInfo = timeout > this.RELAY_CONFIG.BASE_TIMEOUT_MS
                        ? ` (extended due to rate limiting)`
                        : '';
                    reject(new Error(`Request timed out after ${Math.round(timeout/1000)}s${throttleInfo}`));
                }
            }, timeout);
        });

        if (timeout > this.RELAY_CONFIG.BASE_TIMEOUT_MS) {
            console.log(`NIP-46: Using extended timeout ${Math.round(timeout/1000)}s due to rate limiting`);
        }

        // Get healthy sockets sorted by throttle (least-throttled first)
        const healthySockets = this.getHealthySockets();

        if (healthySockets.length === 0) {
            // No healthy sockets - check if we can reset circuit breakers
            const openSockets = this.sockets.filter(ws => ws.readyState === WebSocket.OPEN);
            if (openSockets.length > 0) {
                console.warn('NIP-46: No healthy sockets, resetting circuit breakers for open connections');
                openSockets.forEach(ws => this.relayHealth.delete(ws.url));
            } else {
                this.pendingRequests.delete(id);
                throw new Error('No healthy relay connections available');
            }
        }

        // Store event for potential retry after AUTH
        const firstHealthySocket = healthySockets[0] || this.sockets.find(ws => ws.readyState === WebSocket.OPEN);
        if (firstHealthySocket && !this.authenticated) {
            this.pendingRetry = { event, ws: firstHealthySocket };
        }

        // Publish event with throttle-aware sending
        const message = JSON.stringify(['EVENT', event]);
        const socketsToUse = healthySockets.length > 0 ? healthySockets : this.sockets;

        // Send to relays, respecting per-relay throttle
        // First relay (least-throttled) sends immediately, others may wait
        const sendToRelay = async (ws, index) => {
            if (ws.readyState !== WebSocket.OPEN) return;

            // First relay sends immediately for responsiveness
            // Others wait for throttle to avoid rate limiting
            if (index > 0) {
                await this.waitForThrottle(ws.url);
            } else {
                // Record request time even for first relay
                const health = this.getRelayHealth(ws.url);
                health.lastRequest = Date.now();
            }

            ws.send(message);
        };

        // Send to all relays (parallel, each respecting its own throttle)
        socketsToUse.forEach((ws, index) => {
            sendToRelay(ws, index).catch(err => {
                console.warn('NIP-46: Failed to send to', ws.url, err.message);
            });
        });

        return responsePromise;
    },

    // Default relay for NIP-46 traffic (rate-limit exempt for kind:24133)
    DEFAULT_NIP46_RELAY: 'wss://relay.cloistr.xyz',

    // Connect to bunker
    async connect(bunkerUrl) {
        // Reset any existing state first (handles case where previous attempt failed)
        this.reset();

        // Wait for secp256k1 library
        await this.waitForSecp256k1();

        // Parse bunker URL
        const { remotePubkey, relayUrls, secret } = this.parseBunkerUrl(bunkerUrl);

        // Ensure relay.cloistr.xyz is included for NIP-46 traffic
        // (it's rate-limit exempt for kind:24133 - see architecture/development-philosophy.md)
        const finalRelays = [...relayUrls];
        if (!finalRelays.includes(this.DEFAULT_NIP46_RELAY)) {
            // Add at the beginning for priority
            finalRelays.unshift(this.DEFAULT_NIP46_RELAY);
            console.log('NIP-46: Added relay.cloistr.xyz for rate-limit exempt NIP-46 traffic');
        }

        this.remotePubkey = remotePubkey;
        this.relayUrls = finalRelays;
        this.secret = secret;

        // Generate client keypair
        await this.generateClientKeypair();

        // Connect to all relays
        await this.connectRelays(relayUrls);

        // Subscribe to responses on all relays
        this.subscribeToResponses();

        // Send connect request
        const result = await this.sendRequest('connect', [this.clientPubkey, secret]);

        // Check if signer returned pubkey in connect response (cloistr extension)
        // This saves a round-trip on rate-limited relays
        // Result may be string "ack", string '{"pubkey":"..."}', or object {pubkey:"..."}
        let connectData = result;
        if (typeof result === 'string' && result.startsWith('{')) {
            try {
                connectData = JSON.parse(result);
            } catch (e) {
                // Not JSON, treat as standard "ack"
            }
        }

        if (connectData && typeof connectData === 'object' && connectData.pubkey) {
            console.log('NIP-46: Got pubkey from connect response (skipping get_public_key)');
            this.userPubkey = connectData.pubkey;
        } else {
            // Standard NIP-46: separate get_public_key call
            this.userPubkey = await this.sendRequest('get_public_key', []);
        }
        this.connected = true;

        // Note: We don't proactively re-authenticate here anymore to avoid
        // race conditions with other sign requests. Instead, if we get
        // "auth-required" or "restricted" on publish, the retry logic will
        // handle re-authentication at that time.

        // Save session for persistence
        this.saveSession();

        return this.userPubkey;
    },

    // Session persistence storage key
    STORAGE_KEY: 'cloistr_nip46_session',

    // Save session to localStorage
    saveSession() {
        if (!this.connected || !this.userPubkey) return;

        const session = {
            remotePubkey: this.remotePubkey,
            relayUrls: this.relayUrls,
            secret: this.secret,
            userPubkey: this.userPubkey,
            clientPrivkey: this.clientPrivkey,
            clientPubkey: this.clientPubkey,
        };

        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(session));
            console.log('NIP-46: Session saved');
        } catch (err) {
            console.warn('NIP-46: Failed to save session:', err);
        }
    },

    // Load session from localStorage
    loadSession() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY);
            if (!data) return null;

            const session = JSON.parse(data);
            if (!session.remotePubkey || !session.relayUrls || !session.clientPrivkey) {
                return null;
            }

            return session;
        } catch (err) {
            console.warn('NIP-46: Failed to load session:', err);
            return null;
        }
    },

    // Clear saved session
    clearSession() {
        try {
            localStorage.removeItem(this.STORAGE_KEY);
            console.log('NIP-46: Session cleared');
        } catch (err) {
            console.warn('NIP-46: Failed to clear session:', err);
        }
    },

    // Restore a saved session (reconnect without user interaction)
    async restoreSession() {
        const session = this.loadSession();
        if (!session) {
            return null;
        }

        console.log('NIP-46: Restoring session...');

        // Reset any existing state first
        this.reset();

        try {
            // Wait for secp256k1 library
            await this.waitForSecp256k1();

            // Restore state from saved session
            this.remotePubkey = session.remotePubkey;
            this.secret = session.secret;
            this.userPubkey = session.userPubkey;
            this.clientPrivkey = session.clientPrivkey;
            this.clientPubkey = session.clientPubkey;

            // Ensure relay.cloistr.xyz is included for NIP-46 traffic
            const sessionRelays = session.relayUrls || [];
            if (!sessionRelays.includes(this.DEFAULT_NIP46_RELAY)) {
                sessionRelays.unshift(this.DEFAULT_NIP46_RELAY);
                console.log('NIP-46: Added relay.cloistr.xyz for rate-limit exempt NIP-46 traffic');
            }
            this.relayUrls = sessionRelays;

            // Connect to relays
            await this.connectRelays(this.relayUrls);

            // Subscribe to responses
            this.subscribeToResponses();

            // Send connect request with a shorter timeout for restore
            // (signer should respond quickly if it's available)
            const connectPromise = this.sendRequest('connect', [this.clientPubkey, this.secret]);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Session restore timed out - signer may be offline')), 30000)
            );

            await Promise.race([connectPromise, timeoutPromise]);

            this.connected = true;

            // Note: Re-authentication happens lazily on first publish if needed
            // (when we get "auth-required" or "restricted" errors)

            console.log('NIP-46: Session restored successfully');

            return this.userPubkey;
        } catch (err) {
            console.error('NIP-46: Failed to restore session:', err);

            // Full state reset on failure to ensure clean state for next attempt
            this.reset();

            // Don't clear the saved session on timeout - user can try manual login
            // Only clear if it's an explicit rejection
            if (err.message && (err.message.includes('invalid') || err.message.includes('denied') || err.message.includes('unauthorized'))) {
                this.clearSession();
            }

            return null;
        }
    },

    // Check if there's a saved session
    hasSavedSession() {
        return this.loadSession() !== null;
    },

    // Full state reset (clears everything except session storage)
    reset() {
        // Close all relay connections
        this.sockets.forEach(ws => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        this.sockets = [];

        // Reset connection state
        this.connected = false;
        this.userPubkey = null;
        this.remotePubkey = null;
        this.relayUrls = [];
        this.secret = null;
        this.clientPrivkey = null;
        this.clientPubkey = null;

        // Clear all pending state
        this.pendingRequests.clear();
        this.pendingPublishes.clear();
        this.seenEvents.clear();
        this.pendingAuth = null;
        this.pendingRetry = null;
        this.pendingAuthRetries = [];
        this.authenticated = false;
        this.requestId = 0;

        console.log('NIP-46: State reset complete');
    },

    // Disconnect from bunker
    disconnect() {
        // Clear saved session
        this.clearSession();

        // Clear circuit breaker state (fresh start on explicit disconnect)
        this.relayHealth.clear();

        // Full state reset
        this.reset();
    },

    // Sign an event (mimics window.nostr.signEvent)
    async signEvent(event) {
        if (!this.connected) {
            throw new Error('Not connected to remote signer');
        }

        // Add pubkey if not present
        if (!event.pubkey) {
            event.pubkey = this.userPubkey;
        }

        console.log('NIP-46: signEvent called for kind:', event.kind);

        // Send sign_event request
        const signedEvent = await this.sendRequest('sign_event', [JSON.stringify(event)]);
        console.log('NIP-46: signEvent got response, type:', typeof signedEvent, 'value:', signedEvent);

        // Parse the result (some signers return string, some return object)
        if (typeof signedEvent === 'string') {
            console.log('NIP-46: signEvent parsing string, first 100 chars:', signedEvent.substring(0, 100));
            try {
                return JSON.parse(signedEvent);
            } catch (err) {
                console.error('NIP-46: Failed to parse signEvent result:', err.message);
                console.error('NIP-46: Raw value (length=' + signedEvent.length + '):', JSON.stringify(signedEvent));
                throw err;
            }
        }

        return signedEvent;
    },

    // Batch sign multiple events in one request (reduces round-trips on rate-limited relays)
    // Cloistr extension: not part of standard NIP-46
    async batchSignEvents(events) {
        if (!this.connected) {
            throw new Error('Not connected to remote signer');
        }

        if (!events || events.length === 0) {
            return [];
        }

        // Add pubkey if not present
        const eventsWithPubkey = events.map(event => ({
            ...event,
            pubkey: event.pubkey || this.userPubkey,
        }));

        console.log('NIP-46: batchSignEvents called for', events.length, 'events');

        // Try batch_sign first (cloistr extension)
        try {
            const params = eventsWithPubkey.map(e => JSON.stringify(e));
            const result = await this.sendRequest('batch_sign', params);

            // Parse the result (array of signed events)
            let signedEvents;
            if (typeof result === 'string') {
                signedEvents = JSON.parse(result);
            } else {
                signedEvents = result;
            }

            // Parse each signed event if needed
            return signedEvents.map((se, i) => {
                if (typeof se === 'string') {
                    return JSON.parse(se);
                }
                return se;
            });
        } catch (err) {
            // If batch_sign not supported, fall back to individual signEvent calls
            if (err.message.includes('unknown method')) {
                console.log('NIP-46: batch_sign not supported, falling back to individual signs');
                const signedEvents = [];
                for (const event of eventsWithPubkey) {
                    signedEvents.push(await this.signEvent(event));
                }
                return signedEvents;
            }
            throw err;
        }
    },

    // Get public key (mimics window.nostr.getPublicKey)
    async getPublicKey() {
        if (!this.connected) {
            throw new Error('Not connected to remote signer');
        }

        return this.userPubkey;
    },

    // Publish a signed event to all connected relays and wait for confirmation
    async publishEvent(signedEvent) {
        if (this.sockets.length === 0) {
            throw new Error('Not connected to any relay');
        }

        console.log('NIP-46: Publishing event kind:', signedEvent.kind, 'id:', signedEvent.id?.slice(0, 8));

        const message = JSON.stringify(['EVENT', signedEvent]);
        const openSockets = this.sockets.filter(ws => ws.readyState === WebSocket.OPEN);

        if (openSockets.length === 0) {
            throw new Error('No open relay connections');
        }

        // Create promise that waits for at least one OK response
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPublishes.delete(signedEvent.id);
                reject(new Error('Publish timeout - no OK response from relay'));
            }, 15000);

            // Track this publish (include event for potential auth retry)
            this.pendingPublishes.set(signedEvent.id, {
                event: signedEvent,
                resolve: (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                },
            });

            // Send to all open relays
            let sent = 0;
            for (const ws of openSockets) {
                try {
                    ws.send(message);
                    sent++;
                } catch (err) {
                    console.warn('NIP-46: Failed to send to', ws.url, err);
                }
            }

            if (sent === 0) {
                clearTimeout(timeout);
                this.pendingPublishes.delete(signedEvent.id);
                reject(new Error('Failed to send to any relay'));
            } else {
                console.log('NIP-46: Sent event to', sent, 'relay(s), waiting for OK...');
            }
        });
    },
};

// Export for use in other modules
window.NIP46 = NIP46;
