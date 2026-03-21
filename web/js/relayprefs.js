// Relay Preferences Module
// Mirrors cloistr-common/relayprefs for TypeScript/JavaScript services
// See: ~/claude/coldforge/cloistr/architecture/relay-preferences.md

const RelayPrefs = {
    // Discovery endpoints
    DISCOVERY_URL: 'https://discover.cloistr.xyz',
    DEFAULT_RELAY: 'wss://relay.cloistr.xyz',

    // Cache (in-memory, cleared on page refresh)
    cache: new Map(),
    CACHE_TTL: 60 * 60 * 1000, // 1 hour in ms

    // Event kind and d-tag for cloistr relay preferences
    KIND: 30078,
    D_TAG: 'cloistr-relays',

    // NIP-65 kind for fallback
    NIP65_KIND: 10002,

    // Get relay preferences for a pubkey
    // Returns: { readRelays: [], writeRelays: [], source: string }
    async getRelayPrefs(pubkey) {
        if (!pubkey) {
            return this.defaultPrefs();
        }

        // Check cache first
        const cached = this.getFromCache(pubkey);
        if (cached) {
            console.log('RelayPrefs: Using cached preferences for', pubkey.slice(0, 8));
            return cached;
        }

        // Try discovery service first (fast path)
        try {
            const prefs = await this.queryDiscovery(pubkey);
            if (prefs) {
                this.setCache(pubkey, prefs);
                return prefs;
            }
        } catch (err) {
            console.warn('RelayPrefs: Discovery query failed:', err.message);
        }

        // Fallback: query relay directly for cloistr-relays event
        try {
            const prefs = await this.queryRelayDirect(pubkey);
            if (prefs) {
                this.setCache(pubkey, prefs);
                return prefs;
            }
        } catch (err) {
            console.warn('RelayPrefs: Direct relay query failed:', err.message);
        }

        // Final fallback: default relay
        const defaultPrefs = this.defaultPrefs();
        this.setCache(pubkey, defaultPrefs);
        return defaultPrefs;
    },

    // Query discovery service for relay preferences
    async queryDiscovery(pubkey) {
        const url = `${this.DISCOVERY_URL}/api/v1/relay-prefs/${pubkey}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            if (response.status === 404) {
                // No preferences found, not an error
                return null;
            }
            throw new Error(`Discovery returned ${response.status}`);
        }

        const data = await response.json();
        return this.parseDiscoveryResponse(data);
    },

    // Parse discovery service response
    parseDiscoveryResponse(data) {
        if (!data || !data.relays || data.relays.length === 0) {
            return null;
        }

        const readRelays = [];
        const writeRelays = [];

        for (const relay of data.relays) {
            if (relay.read) {
                readRelays.push(relay.url);
            }
            if (relay.write) {
                writeRelays.push(relay.url);
            }
        }

        if (readRelays.length === 0 && writeRelays.length === 0) {
            return null;
        }

        return {
            readRelays,
            writeRelays,
            source: data.source || 'discovery',
            cachedAt: Date.now(),
        };
    },

    // Query relay directly for cloistr-relays or NIP-65 event
    async queryRelayDirect(pubkey) {
        // Try to use existing Relay module connection
        if (typeof Relay === 'undefined') {
            console.warn('RelayPrefs: Relay module not available for direct query');
            return null;
        }

        // Ensure connected
        if (!Relay.connected) {
            await Relay.connect();
        }

        // First try cloistr-relays (kind:30078 d=cloistr-relays)
        let prefs = await this.queryForEvent(pubkey, this.KIND, this.D_TAG);
        if (prefs) {
            prefs.source = 'cloistr-relays';
            return prefs;
        }

        // Fallback to NIP-65 (kind:10002)
        prefs = await this.queryForNIP65(pubkey);
        if (prefs) {
            prefs.source = 'nip65';
            return prefs;
        }

        return null;
    },

    // Query for a specific addressable event
    async queryForEvent(pubkey, kind, dTag) {
        return new Promise((resolve) => {
            const subId = 'relayprefs-' + Date.now();
            const filter = {
                kinds: [kind],
                authors: [pubkey],
                '#d': [dTag],
                limit: 1,
            };

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
            }, 5000);

            // Create a temporary message handler
            const originalHandler = Relay.socket.onmessage;
            Relay.socket.onmessage = (msg) => {
                try {
                    const message = JSON.parse(msg.data);
                    if (message[0] === 'EVENT' && message[1] === subId) {
                        const event = message[2];
                        clearTimeout(timeout);
                        resolved = true;

                        // Close subscription
                        Relay.send(['CLOSE', subId]);
                        Relay.socket.onmessage = originalHandler;

                        // Parse relay tags
                        resolve(this.parseRelayTags(event.tags));
                    } else if (message[0] === 'EOSE' && message[1] === subId) {
                        if (!resolved) {
                            clearTimeout(timeout);
                            resolved = true;
                            Relay.send(['CLOSE', subId]);
                            Relay.socket.onmessage = originalHandler;
                            resolve(null);
                        }
                    } else {
                        // Pass to original handler
                        if (originalHandler) {
                            originalHandler(msg);
                        }
                    }
                } catch (err) {
                    console.warn('RelayPrefs: Error processing cloistr-relays message:', err.message);
                    if (originalHandler) {
                        originalHandler(msg);
                    }
                }
            };

            // Send subscription
            Relay.send(['REQ', subId, filter]);
        });
    },

    // Query for NIP-65 relay list
    async queryForNIP65(pubkey) {
        return new Promise((resolve) => {
            const subId = 'nip65-' + Date.now();
            const filter = {
                kinds: [this.NIP65_KIND],
                authors: [pubkey],
                limit: 1,
            };

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
            }, 5000);

            const originalHandler = Relay.socket.onmessage;
            Relay.socket.onmessage = (msg) => {
                try {
                    const message = JSON.parse(msg.data);
                    if (message[0] === 'EVENT' && message[1] === subId) {
                        const event = message[2];
                        clearTimeout(timeout);
                        resolved = true;
                        Relay.send(['CLOSE', subId]);
                        Relay.socket.onmessage = originalHandler;
                        resolve(this.parseRelayTags(event.tags));
                    } else if (message[0] === 'EOSE' && message[1] === subId) {
                        if (!resolved) {
                            clearTimeout(timeout);
                            resolved = true;
                            Relay.send(['CLOSE', subId]);
                            Relay.socket.onmessage = originalHandler;
                            resolve(null);
                        }
                    } else {
                        if (originalHandler) {
                            originalHandler(msg);
                        }
                    }
                } catch (err) {
                    console.warn('RelayPrefs: Error processing NIP-65 message:', err.message);
                    if (originalHandler) {
                        originalHandler(msg);
                    }
                }
            };

            Relay.send(['REQ', subId, filter]);
        });
    },

    // Parse relay tags from event (works for both cloistr-relays and NIP-65)
    parseRelayTags(tags) {
        const readRelays = [];
        const writeRelays = [];

        for (const tag of tags) {
            if (tag[0] !== 'r') continue;

            const url = tag[1];
            if (!url || !url.startsWith('wss://')) continue;

            const marker = tag[2]; // 'read', 'write', or undefined (both)

            if (!marker || marker === 'read') {
                readRelays.push(url);
            }
            if (!marker || marker === 'write') {
                writeRelays.push(url);
            }
        }

        if (readRelays.length === 0 && writeRelays.length === 0) {
            return null;
        }

        return {
            readRelays,
            writeRelays,
            cachedAt: Date.now(),
        };
    },

    // Default preferences (relay.cloistr.xyz)
    defaultPrefs() {
        return {
            readRelays: [this.DEFAULT_RELAY],
            writeRelays: [this.DEFAULT_RELAY],
            source: 'default',
            cachedAt: Date.now(),
        };
    },

    // Cache management
    getFromCache(pubkey) {
        const entry = this.cache.get(pubkey);
        if (!entry) return null;

        // Check TTL
        if (Date.now() - entry.cachedAt > this.CACHE_TTL) {
            this.cache.delete(pubkey);
            return null;
        }

        return entry;
    },

    setCache(pubkey, prefs) {
        this.cache.set(pubkey, prefs);
    },

    invalidateCache(pubkey) {
        if (pubkey) {
            this.cache.delete(pubkey);
        } else {
            this.cache.clear();
        }
    },

    // Create a cloistr-relays event for signing
    createRelayPrefsEvent(relays) {
        const tags = [['d', this.D_TAG]];

        for (const relay of relays) {
            if (relay.read && relay.write) {
                tags.push(['r', relay.url]);
            } else if (relay.read) {
                tags.push(['r', relay.url, 'read']);
            } else if (relay.write) {
                tags.push(['r', relay.url, 'write']);
            }
        }

        return {
            kind: this.KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: '',
        };
    },

    // Publish user's relay preferences (called from settings UI)
    async publishRelayPrefs(relays) {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        // Create event
        const event = this.createRelayPrefsEvent(relays);

        // Sign it
        const signedEvent = await Auth.signEvent(event);

        // Get current relay prefs to know where to publish
        const currentPrefs = await this.getRelayPrefs(Auth.pubkey);

        // Collect all write relays to publish to
        const writeRelays = new Set();
        for (const url of currentPrefs.writeRelays) {
            writeRelays.add(url);
        }
        for (const relay of relays) {
            if (relay.write) {
                writeRelays.add(relay.url);
            }
        }

        // Need at least one write relay to save
        if (writeRelays.size === 0) {
            throw new Error('At least one relay must have write enabled to save preferences');
        }

        // Publish to all write relays
        const publishPromises = [];
        for (const url of writeRelays) {
            publishPromises.push(this.publishToRelay(url, signedEvent));
        }

        const results = await Promise.allSettled(publishPromises);

        // Check if at least one publish succeeded
        const successes = results.filter(r => r.status === 'fulfilled').length;

        console.log(`RelayPrefs: Published to ${successes}/${results.length} relays`);

        if (successes === 0) {
            const errors = results
                .filter(r => r.status === 'rejected')
                .map(r => r.reason?.message || 'Unknown error')
                .join(', ');
            throw new Error(`Failed to publish to any relay: ${errors}`);
        }

        // Invalidate cache
        this.invalidateCache(Auth.pubkey);

        return signedEvent;
    },

    // Publish to a specific relay
    async publishToRelay(url, event) {
        // Use existing authenticated Relay connection for cloistr relay
        if (typeof Relay !== 'undefined' && url === Relay.defaultUrl) {
            console.log('RelayPrefs: Using authenticated Relay.publish for', url);
            return Relay.publish(event);
        }

        // For other relays, open direct connection (may fail if auth required)
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
                            resolve({ success: true });
                        } else {
                            reject(new Error(message[3] || 'Rejected'));
                        }
                    }
                } catch (err) {
                    console.warn('RelayPrefs: Failed to parse relay message:', err.message, msg.data);
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Connection failed'));
            };
        });
    },
};

// Export for use in other modules
window.RelayPrefs = RelayPrefs;
