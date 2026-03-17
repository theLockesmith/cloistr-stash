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
                        } else {
                            pending.reject(new Error(okMessage || 'Publish rejected'));
                        }
                        this.pendingPublishes.delete(eventId);
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

        } catch (err) {
            console.error('Relay: Failed to handle auth challenge:', err);
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
    },

    // Check if connected
    isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    },
};
