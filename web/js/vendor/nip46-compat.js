/**
 * NIP-46 Compatibility Layer
 *
 * Wraps @cloistr/collab-common UMD auth module to provide the legacy NIP46
 * singleton interface that cloistr-stash expects.
 *
 * This file should be loaded AFTER cloistr-auth.umd.js
 */

(function() {
    'use strict';

    // Get the UMD module - it exposes window.CloistAuth
    const CloistAuth = window.CloistAuth;
    if (!CloistAuth) {
        console.error('NIP46 compat: CloistAuth not found. Load cloistr-auth.umd.js first.');
        return;
    }

    // Internal state
    let currentSigner = null;

    // Create the NIP46 singleton that mirrors the legacy API
    window.NIP46 = {
        // Connection state (exposed as properties for legacy compatibility)
        connected: false,
        userPubkey: null,
        remotePubkey: null,
        relayUrls: [],
        secret: null,

        // Session storage key (same as original for backwards compat)
        SESSION_KEY: 'cloistr_nip46_session',

        /**
         * Connect to a bunker URL
         * @param {string} bunkerUrl - bunker://pubkey?relay=...&secret=...
         * @returns {Promise<string>} User's public key
         */
        async connect(bunkerUrl) {
            try {
                console.log('NIP46 compat: Connecting to bunker...');

                currentSigner = await CloistAuth.connectNip46({ bunkerUrl });

                this.userPubkey = await currentSigner.getPublicKey();
                this.relayUrls = currentSigner.getRelayUrls ? currentSigner.getRelayUrls() : [];
                this.connected = true;

                console.log('NIP46 compat: Connected as', this.userPubkey);
                return this.userPubkey;
            } catch (err) {
                console.error('NIP46 compat: Connection failed:', err);
                this.connected = false;
                this.userPubkey = null;
                throw err;
            }
        },

        /**
         * Check if there's a saved session
         * @returns {boolean}
         */
        hasSavedSession() {
            return CloistAuth.hasNip46Session();
        },

        /**
         * Restore a saved session
         * @returns {Promise<string|null>} User's public key or null
         */
        async restoreSession() {
            try {
                console.log('NIP46 compat: Restoring session...');

                const result = await CloistAuth.restoreNip46Session();

                if (result && result.signer) {
                    currentSigner = result.signer;
                    this.userPubkey = result.pubkey;
                    this.relayUrls = currentSigner.getRelayUrls ? currentSigner.getRelayUrls() : [];
                    this.connected = true;

                    console.log('NIP46 compat: Session restored for', this.userPubkey);
                    return this.userPubkey;
                }

                return null;
            } catch (err) {
                console.error('NIP46 compat: Session restore failed:', err);
                return null;
            }
        },

        /**
         * Sign a Nostr event
         * @param {object} event - Unsigned event
         * @returns {Promise<object>} Signed event
         */
        async signEvent(event) {
            if (!this.connected || !currentSigner) {
                throw new Error('Not connected. Call connect() first.');
            }
            return currentSigner.signEvent(event);
        },

        /**
         * Batch sign multiple events (cloistr-signer extension)
         * Falls back to individual signing if not supported
         * @param {object[]} events - Array of unsigned events
         * @returns {Promise<object[]>} Array of signed events
         */
        async batchSignEvents(events) {
            if (!this.connected || !currentSigner) {
                throw new Error('Not connected. Call connect() first.');
            }

            // Use batch signing if available
            if (currentSigner.batchSignEvents) {
                return currentSigner.batchSignEvents(events);
            }

            // Fallback to individual signing
            console.log('NIP46 compat: batch_sign not available, using sequential signing');
            const signed = [];
            for (const event of events) {
                signed.push(await currentSigner.signEvent(event));
            }
            return signed;
        },

        /**
         * Encrypt content for a recipient using NIP-04
         * Uses the remote signer's key (user's actual key)
         * @param {string} plaintext - Content to encrypt
         * @param {string} recipientPubkey - Recipient's public key
         * @returns {Promise<string>} Encrypted content
         */
        async encryptForUser(plaintext, recipientPubkey) {
            if (!this.connected || !currentSigner) {
                throw new Error('Not connected. Call connect() first.');
            }
            return currentSigner.encrypt(recipientPubkey, plaintext);
        },

        /**
         * Decrypt content from a sender using NIP-04
         * Uses the remote signer's key (user's actual key)
         * @param {string} ciphertext - Encrypted content
         * @param {string} senderPubkey - Sender's public key
         * @returns {Promise<string>} Decrypted content
         */
        async decryptForUser(ciphertext, senderPubkey) {
            if (!this.connected || !currentSigner) {
                throw new Error('Not connected. Call connect() first.');
            }
            return currentSigner.decrypt(senderPubkey, ciphertext);
        },

        /**
         * Encrypt content with NIP-04 (alias for encryptForUser)
         * @param {string} plaintext - Content to encrypt
         * @param {string} recipientPubkey - Recipient's public key
         * @returns {Promise<string>} Encrypted content
         */
        async encrypt(plaintext, recipientPubkey) {
            return this.encryptForUser(plaintext, recipientPubkey);
        },

        /**
         * Decrypt content with NIP-04 (alias for decryptForUser)
         * @param {string} ciphertext - Encrypted content
         * @param {string} senderPubkey - Sender's public key
         * @returns {Promise<string>} Decrypted content
         */
        async decrypt(ciphertext, senderPubkey) {
            return this.decryptForUser(ciphertext, senderPubkey);
        },

        /**
         * Publish a signed event to relays
         * @param {object} signedEvent - Signed Nostr event
         * @returns {Promise<void>}
         */
        async publishEvent(signedEvent) {
            if (!this.connected || !currentSigner) {
                throw new Error('Not connected. Call connect() first.');
            }

            // Use signer's publishEvent if available
            if (currentSigner.publishEvent) {
                return currentSigner.publishEvent(signedEvent);
            }

            // Fallback: publish directly to relay URLs
            const relays = this.relayUrls;
            if (relays.length === 0) {
                throw new Error('No relay URLs available');
            }

            const results = await Promise.allSettled(
                relays.map(url => this._publishToRelay(url, signedEvent))
            );

            const successes = results.filter(r => r.status === 'fulfilled');
            if (successes.length === 0) {
                const errors = results.map(r => r.reason?.message || 'Unknown error').join(', ');
                throw new Error(`Failed to publish to any relay: ${errors}`);
            }

            console.log(`NIP46 compat: Published to ${successes.length}/${relays.length} relays`);
        },

        /**
         * Publish to a single relay
         * @private
         */
        async _publishToRelay(url, event) {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(url);
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('Timeout'));
                }, 10000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['EVENT', event]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const message = JSON.parse(msg.data);
                        if (message[0] === 'OK' && message[1] === event.id) {
                            clearTimeout(timeout);
                            ws.close();
                            if (message[2]) {
                                resolve();
                            } else {
                                reject(new Error(message[3] || 'Rejected'));
                            }
                        }
                    } catch (err) {
                        // Ignore parse errors
                    }
                };

                ws.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error('Connection failed'));
                };
            });
        },

        /**
         * Disconnect from the remote signer
         */
        disconnect() {
            if (currentSigner && currentSigner.disconnect) {
                currentSigner.disconnect();
            }
            CloistAuth.clearNip46Session();

            currentSigner = null;
            this.connected = false;
            this.userPubkey = null;
            this.remotePubkey = null;
            this.relayUrls = [];
            this.secret = null;

            console.log('NIP46 compat: Disconnected');
        },

        /**
         * Get the current signer instance (for advanced usage)
         * @returns {object|null}
         */
        getSigner() {
            return currentSigner;
        },
    };

    console.log('NIP46 compat: Compatibility layer loaded');
})();
