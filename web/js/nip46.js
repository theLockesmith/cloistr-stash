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

    // Connect to a single relay via WebSocket
    connectSingleRelay(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);

            ws.onopen = () => {
                console.log('NIP-46: Connected to', url);
                resolve(ws);
            };

            ws.onerror = (err) => {
                console.error('NIP-46: Connection failed to', url);
                resolve(null); // Don't reject, allow other relays to work
            };

            ws.onclose = () => {
                console.log('NIP-46: Disconnected from', url);
                this.sockets = this.sockets.filter(s => s !== ws);
            };

            ws.onmessage = (msg) => {
                this.handleRelayMessage(msg.data);
            };
        });
    },

    // Connect to all relays
    async connectRelays(urls) {
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

        // Create auth event (kind 22242)
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

        // Sign the auth event
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

    // Handle incoming relay messages
    async handleRelayMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('NIP-46: Received message:', message[0], message.length > 2 ? JSON.stringify(message[2]).slice(0, 100) : '');

            // Handle NIP-42 AUTH challenge
            if (message[0] === 'AUTH') {
                const challenge = message[1];
                // Find the socket that received this
                for (const ws of this.sockets) {
                    if (ws.readyState === WebSocket.OPEN) {
                        await this.handleAuthChallenge(challenge, ws.url, ws);
                        break;
                    }
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
                    console.log('NIP-46: Decrypting response...');
                    // Decrypt the content
                    const decrypted = await this.nip04Decrypt(event.content, this.remotePubkey);
                    const response = JSON.parse(decrypted);
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
                        // Retry pending event if any
                        if (this.pendingRetry) {
                            console.log('NIP-46: Retrying pending request after auth...');
                            const { event, ws } = this.pendingRetry;
                            this.pendingRetry = null;
                            ws.send(JSON.stringify(['EVENT', event]));
                        }
                    } else {
                        console.error('NIP-46: AUTH failed:', reason);
                    }
                    this.pendingAuth = null;
                } else if (reason.includes('auth-required')) {
                    // Event was rejected due to auth-required
                    console.log('NIP-46: Event requires auth, waiting for AUTH challenge...');
                    // Reject the pending publish if it's auth-required
                    const pending = this.pendingPublishes.get(eventId);
                    if (pending) {
                        pending.reject(new Error('auth-required: ' + reason));
                        this.pendingPublishes.delete(eventId);
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

        // Create promise for response
        const responsePromise = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            // Timeout after 60 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Request timed out'));
                }
            }, 60000);
        });

        // Store event for potential retry after AUTH
        // Only store the first socket's event for retry
        const firstOpenSocket = this.sockets.find(ws => ws.readyState === WebSocket.OPEN);
        if (firstOpenSocket && !this.authenticated) {
            this.pendingRetry = { event, ws: firstOpenSocket };
        }

        // Publish event to all relays
        const message = JSON.stringify(['EVENT', event]);
        this.sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });

        return responsePromise;
    },

    // Connect to bunker
    async connect(bunkerUrl) {
        // Wait for secp256k1 library
        await this.waitForSecp256k1();

        // Parse bunker URL
        const { remotePubkey, relayUrls, secret } = this.parseBunkerUrl(bunkerUrl);

        this.remotePubkey = remotePubkey;
        this.relayUrls = relayUrls;
        this.secret = secret;

        // Generate client keypair
        await this.generateClientKeypair();

        // Connect to all relays
        await this.connectRelays(relayUrls);

        // Subscribe to responses on all relays
        this.subscribeToResponses();

        // Send connect request
        const result = await this.sendRequest('connect', [this.clientPubkey, secret]);

        // Get user's public key
        this.userPubkey = await this.sendRequest('get_public_key', []);
        this.connected = true;

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

        try {
            // Wait for secp256k1 library
            await this.waitForSecp256k1();

            // Restore state from saved session
            this.remotePubkey = session.remotePubkey;
            this.relayUrls = session.relayUrls;
            this.secret = session.secret;
            this.userPubkey = session.userPubkey;
            this.clientPrivkey = session.clientPrivkey;
            this.clientPubkey = session.clientPubkey;

            // Connect to relays
            await this.connectRelays(this.relayUrls);

            // Subscribe to responses
            this.subscribeToResponses();

            // Send connect request to re-establish session
            await this.sendRequest('connect', [this.clientPubkey, this.secret]);

            this.connected = true;
            console.log('NIP-46: Session restored successfully');

            return this.userPubkey;
        } catch (err) {
            console.error('NIP-46: Failed to restore session:', err);
            // Don't clear the session on restore failure - user can try again
            // Only clear if it's an authentication error, not a timeout/network issue
            if (err.message && (err.message.includes('invalid') || err.message.includes('denied') || err.message.includes('unauthorized'))) {
                this.clearSession();
            }
            // Close relay connections but keep session data
            this.sockets.forEach(ws => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            });
            this.sockets = [];
            this.connected = false;
            return null;
        }
    },

    // Check if there's a saved session
    hasSavedSession() {
        return this.loadSession() !== null;
    },

    // Disconnect from bunker
    disconnect() {
        // Clear saved session
        this.clearSession();

        // Close all relay connections
        this.sockets.forEach(ws => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        this.sockets = [];

        this.connected = false;
        this.userPubkey = null;
        this.remotePubkey = null;
        this.relayUrls = [];
        this.clientPrivkey = null;
        this.clientPubkey = null;
        this.pendingRequests.clear();
        this.seenEvents.clear();
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
        console.log('NIP-46: signEvent got response, type:', typeof signedEvent);

        // Parse the result (some signers return string, some return object)
        if (typeof signedEvent === 'string') {
            return JSON.parse(signedEvent);
        }

        return signedEvent;
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

            // Track this publish
            this.pendingPublishes.set(signedEvent.id, {
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
