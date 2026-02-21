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
        if (typeof nobleSecp256k1 !== 'undefined') {
            return;
        }

        return new Promise((resolve) => {
            window.addEventListener('secp256k1-loaded', resolve, { once: true });
            // Timeout after 5 seconds
            setTimeout(resolve, 5000);
        });
    },

    // Generate ephemeral client keypair
    async generateClientKeypair() {
        await this.waitForSecp256k1();

        if (typeof nobleSecp256k1 === 'undefined') {
            throw new Error('secp256k1 library not loaded');
        }

        // Generate 32 random bytes for private key
        const privkeyBytes = this.randomBytes(32);
        this.clientPrivkey = this.bytesToHex(privkeyBytes);

        // Derive x-only public key using Schnorr (BIP-340) for Nostr
        const pubkeyBytes = nobleSecp256k1.schnorr.getPublicKey(privkeyBytes);
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

    // Handle incoming relay messages
    async handleRelayMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('NIP-46: Received message:', message[0]);

            if (message[0] === 'EVENT') {
                const event = message[2];
                console.log('NIP-46: EVENT kind:', event.kind, 'from:', event.pubkey?.slice(0, 8));
                console.log('NIP-46: Expected from:', this.remotePubkey?.slice(0, 8));

                // Check if this is a response to us (kind 24133)
                if (event.kind === 24133 && event.pubkey === this.remotePubkey) {
                    console.log('NIP-46: Decrypting response...');
                    // Decrypt the content
                    const decrypted = await this.nip04Decrypt(event.content, this.remotePubkey);
                    const response = JSON.parse(decrypted);
                    console.log('NIP-46: Response id:', response.id, 'pending ids:', [...this.pendingRequests.keys()]);

                    // Find pending request
                    const pending = this.pendingRequests.get(response.id);
                    if (pending) {
                        this.pendingRequests.delete(response.id);

                        if (response.error) {
                            pending.reject(new Error(response.error));
                        } else {
                            pending.resolve(response.result);
                        }
                    } else {
                        console.log('NIP-46: No pending request for id:', response.id);
                    }
                }
            } else if (message[0] === 'OK') {
                console.log('NIP-46: Event published:', message[1]?.slice(0, 8), message[2] ? 'accepted' : 'rejected', message[3] || '');
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

        // Sign the event
        await this.waitForSecp256k1();

        if (typeof nobleSecp256k1 === 'undefined') {
            throw new Error('secp256k1 library not loaded');
        }

        const privkeyBytes = this.hexToBytes(this.clientPrivkey);
        const msgBytes = this.hexToBytes(event.id);

        // Use Schnorr signature (BIP-340) for Nostr - returns 64-byte Uint8Array
        const sig = nobleSecp256k1.schnorr.sign(msgBytes, privkeyBytes);
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

        return this.userPubkey;
    },

    // Disconnect from bunker
    disconnect() {
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

        // Send sign_event request
        const signedEvent = await this.sendRequest('sign_event', [JSON.stringify(event)]);

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
};

// Export for use in other modules
window.NIP46 = NIP46;
