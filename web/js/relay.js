// Relay module for direct WebSocket connection to Nostr relay
// Used for NIP-07 users who need to publish events directly

const Relay = {
    // Default relay URL (can be overridden)
    defaultUrl: 'wss://relay.cloistr.xyz',

    // Active WebSocket connection
    socket: null,
    url: null,

    // Connection state
    connected: false,
    authenticated: false,

    // Pending requests (for tracking OK responses)
    pendingPublishes: new Map(),

    // Events pending retry after auth (auth-required rejection)
    pendingAuthRetry: new Map(),

    // Connect to relay
    async connect(url = null) {
        this.url = url || this.defaultUrl;

        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return true;
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 10000);

            try {
                this.socket = new WebSocket(this.url);

                this.socket.onopen = () => {
                    clearTimeout(timeout);
                    this.connected = true;
                    console.log('Relay: Connected to', this.url);
                    resolve(true);
                };

                this.socket.onerror = (err) => {
                    clearTimeout(timeout);
                    console.error('Relay: Connection error:', err);
                    reject(new Error('Failed to connect to relay'));
                };

                this.socket.onclose = () => {
                    this.connected = false;
                    this.authenticated = false;
                    console.log('Relay: Disconnected');
                };

                this.socket.onmessage = (msg) => {
                    this.handleMessage(msg.data);
                };

            } catch (err) {
                clearTimeout(timeout);
                reject(err);
            }
        });
    },

    // Handle incoming messages from relay
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            const type = message[0];

            switch (type) {
                case 'OK':
                    // Event published response: ["OK", event_id, success, message]
                    const [, eventId, success, okMessage] = message;
                    const pending = this.pendingPublishes.get(eventId);
                    if (pending) {
                        if (success) {
                            pending.resolve({ success: true, message: okMessage });
                            this.pendingPublishes.delete(eventId);
                        } else if (okMessage && okMessage.includes('auth')) {
                            // Auth required - queue for retry after authentication
                            console.log('Relay: Auth required for event', eventId.slice(0, 8) + '..., queueing for retry');
                            this.pendingAuthRetry.set(eventId, {
                                event: pending.event,
                                resolve: pending.resolve,
                                reject: pending.reject,
                                timeout: pending.timeout,
                            });
                            this.pendingPublishes.delete(eventId);
                            // Note: don't reject - wait for auth and retry
                        } else {
                            pending.reject(new Error(okMessage || 'Publish rejected'));
                            this.pendingPublishes.delete(eventId);
                        }
                    }
                    break;

                case 'AUTH':
                    // NIP-42 authentication challenge: ["AUTH", challenge]
                    const challenge = message[1];
                    this.handleAuthChallenge(challenge);
                    break;

                case 'NOTICE':
                    // Relay notice: ["NOTICE", message]
                    console.log('Relay notice:', message[1]);
                    break;

                case 'EOSE':
                    // End of stored events (for subscriptions)
                    break;

                case 'EVENT':
                    // Event received (for subscriptions) - not used for publishing
                    break;

                default:
                    console.log('Relay: Unknown message type:', type);
            }
        } catch (err) {
            console.error('Relay: Failed to parse message:', err);
        }
    },

    // Handle NIP-42 authentication challenge
    async handleAuthChallenge(challenge) {
        if (!Auth.isConnected) {
            console.warn('Relay: Auth challenge received but not connected to signer');
            return;
        }

        try {
            console.log('Relay: Responding to NIP-42 auth challenge');

            const now = Math.floor(Date.now() / 1000);
            const authEvent = {
                kind: 22242,
                created_at: now,
                tags: [
                    ['relay', this.url],
                    ['challenge', challenge],
                ],
                content: '',
            };

            // Sign the auth event
            const signedAuth = await Auth.signEvent(authEvent);

            // Send AUTH response
            this.send(['AUTH', signedAuth]);
            this.authenticated = true;
            console.log('Relay: NIP-42 authentication sent');

            // Retry any events that were rejected with auth-required
            await this.retryPendingAfterAuth();

        } catch (err) {
            console.error('Relay: Failed to handle auth challenge:', err);
        }
    },

    // Retry events that were rejected with auth-required after successful auth
    async retryPendingAfterAuth() {
        if (this.pendingAuthRetry.size === 0) {
            return;
        }

        console.log('Relay: Retrying', this.pendingAuthRetry.size, 'events after auth');

        for (const [eventId, pending] of this.pendingAuthRetry) {
            try {
                // Move back to pendingPublishes for response tracking
                this.pendingPublishes.set(eventId, pending);
                this.pendingAuthRetry.delete(eventId);

                // Resend the event
                this.send(['EVENT', pending.event]);
                console.log('Relay: Retried event', eventId.slice(0, 8) + '...');

            } catch (err) {
                console.error('Relay: Failed to retry event', eventId.slice(0, 8) + '...:', err);
                pending.reject(err);
                this.pendingAuthRetry.delete(eventId);
            }
        }
    },

    // Send a message to the relay
    send(message) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected to relay');
        }
        this.socket.send(JSON.stringify(message));
    },

    // Publish a signed event to the relay
    async publish(signedEvent) {
        // Ensure connected - check both flag and actual socket state
        if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
            console.log('Relay: Reconnecting before publish (connected:', this.connected, 'readyState:', this.socket?.readyState, ')');
            await this.connect();
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPublishes.delete(signedEvent.id);
                reject(new Error('Publish timeout'));
            }, 10000);

            // Track this publish (store event for potential retry after auth)
            this.pendingPublishes.set(signedEvent.id, {
                event: signedEvent,
                timeout: timeout,
                resolve: (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                },
            });

            // Send EVENT message
            try {
                this.send(['EVENT', signedEvent]);
                console.log('Relay: Published event', signedEvent.id.slice(0, 8) + '...');
            } catch (err) {
                clearTimeout(timeout);
                this.pendingPublishes.delete(signedEvent.id);
                reject(err);
            }
        });
    },

    // Disconnect from relay
    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.connected = false;
        this.authenticated = false;
        this.pendingPublishes.clear();
        this.pendingAuthRetry.clear();
    },

    // Check if connected
    isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    },
};
