// Collaboration module - Real-time collaborative editing with Yjs CRDT
// Implements zero-knowledge collaboration for Cloistr Drive

const Collaboration = {
    // Active collaboration sessions
    sessions: new Map(),

    // WebRTC configuration
    rtcConfig: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    },

    // Signaling via Nostr relay
    signalingRelay: null,
    signalingSubscription: null,

    // Session key for encrypting CRDT updates
    sessionKeys: new Map(),

    // Yjs documents
    yDocs: new Map(),

    // Awareness states (cursors, presence)
    awareness: new Map(),

    // Initialize collaboration
    async init() {
        console.log('Collaboration: Initialized');
    },

    // Start a collaborative session for a file
    async startSession(file, options = {}) {
        const {
            editorElement = null,
            onSync = null,
            onAwarenessChange = null,
        } = options;

        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        const fileId = file.file_id || file.fileId || file.d;
        if (!fileId) {
            throw new Error('Cannot collaborate: missing file ID');
        }

        // Check if session already exists
        if (this.sessions.has(fileId)) {
            return this.sessions.get(fileId);
        }

        // Generate session ID
        const sessionId = this.generateSessionId(fileId);

        // Generate or derive session key for encrypting CRDT updates
        const sessionKey = await this.deriveSessionKey(file);
        this.sessionKeys.set(sessionId, sessionKey);

        // Create Yjs document
        const yDoc = new Y.Doc();
        this.yDocs.set(sessionId, yDoc);

        // Create awareness for presence/cursors
        const awarenessInstance = new awarenessProtocol.Awareness(yDoc);
        this.awareness.set(sessionId, awarenessInstance);

        // Set local awareness state
        awarenessInstance.setLocalState({
            user: {
                pubkey: Auth.pubkey,
                name: Auth.formatPubkey(Auth.pubkey),
                color: this.generateUserColor(Auth.pubkey),
            },
            cursor: null,
        });

        // Create session object
        const session = {
            id: sessionId,
            fileId: fileId,
            file: file,
            yDoc: yDoc,
            awareness: awarenessInstance,
            peers: new Map(),
            provider: null,
            editor: null,
            startedAt: Date.now(),
            callbacks: {
                onSync: onSync,
                onAwarenessChange: onAwarenessChange,
            },
        };

        // Start WebRTC provider
        await this.startWebRTCProvider(session);

        // Store session
        this.sessions.set(fileId, session);

        // Load initial content
        await this.loadInitialContent(session);

        console.log(`Collaboration: Started session ${sessionId.slice(0, 8)}...`);

        return session;
    },

    // Derive session key from file key
    async deriveSessionKey(file) {
        const fileId = file.file_id || file.fileId || file.d;
        const folderId = file.folder_id || file.folderId || file.folder || null;

        let fileKey;
        if (folderId) {
            fileKey = await Keys.deriveFileKey(folderId, fileId);
        } else {
            fileKey = await Keys.deriveRootFileKey(fileId);
        }

        // Derive session key from file key + 'session' context
        const sessionKey = await Keys.deriveKey(fileKey, 'session', 'cloistr-drive-collab-v1');

        // Wipe file key
        Crypto.wipeKey(fileKey);

        return sessionKey;
    },

    // Start WebRTC provider for peer-to-peer sync
    async startWebRTCProvider(session) {
        // Use Nostr relay for signaling
        await this.setupNostrSignaling(session);

        // Listen for awareness changes
        session.awareness.on('change', (changes) => {
            if (session.callbacks.onAwarenessChange) {
                session.callbacks.onAwarenessChange(changes, session.awareness.getStates());
            }
        });
    },

    // Setup Nostr relay for WebRTC signaling
    async setupNostrSignaling(session) {
        // Use the same relay as NIP-46
        // Signaling messages are encrypted with the session key

        // Subscribe to signaling events for this session
        // Kind 4 ephemeral events with session room tag
        console.log(`Collaboration: Setting up Nostr signaling for session ${session.id.slice(0, 8)}...`);
    },

    // Load initial file content into Yjs document
    async loadInitialContent(session) {
        try {
            // Download and decrypt the file
            const decryptedData = await App.downloadFileData(session.file);

            if (decryptedData) {
                // Parse content based on file type
                const decoder = new TextDecoder();
                const content = decoder.decode(decryptedData);

                // Get the Y.Text type for the document
                const yText = session.yDoc.getText('content');

                // Insert initial content
                yText.insert(0, content);

                console.log('Collaboration: Loaded initial content');

                if (session.callbacks.onSync) {
                    session.callbacks.onSync(session);
                }
            }
        } catch (err) {
            console.warn('Collaboration: Failed to load initial content:', err);
        }
    },

    // Bind Yjs to TipTap editor
    bindToTipTap(session, editor) {
        if (typeof Collaboration === 'undefined' || typeof CollaborationCursor === 'undefined') {
            console.warn('Collaboration: TipTap collaboration extensions not loaded');
            return;
        }

        session.editor = editor;

        // The editor should already be configured with Collaboration extension
        // pointing to session.yDoc
        console.log('Collaboration: Bound to TipTap editor');
    },

    // Bind Yjs to a textarea
    bindToTextarea(session, textarea) {
        const yText = session.yDoc.getText('content');

        // Initial value
        textarea.value = yText.toString();

        // Local changes -> Yjs
        textarea.addEventListener('input', () => {
            const currentValue = yText.toString();
            const newValue = textarea.value;

            if (currentValue !== newValue) {
                // Simple replacement (not optimal for large texts)
                session.yDoc.transact(() => {
                    yText.delete(0, yText.length);
                    yText.insert(0, newValue);
                });
            }
        });

        // Yjs changes -> textarea
        yText.observe((event) => {
            const newContent = yText.toString();
            if (textarea.value !== newContent) {
                const selStart = textarea.selectionStart;
                const selEnd = textarea.selectionEnd;
                textarea.value = newContent;
                // Restore cursor position
                textarea.selectionStart = Math.min(selStart, newContent.length);
                textarea.selectionEnd = Math.min(selEnd, newContent.length);
            }
        });

        console.log('Collaboration: Bound to textarea');
    },

    // Connect to a peer via WebRTC
    async connectPeer(session, peerPubkey) {
        if (session.peers.has(peerPubkey)) {
            return session.peers.get(peerPubkey);
        }

        const pc = new RTCPeerConnection(this.rtcConfig);

        // Create data channel for Yjs sync
        const channel = pc.createDataChannel('yjs-sync', {
            ordered: true,
        });

        const peer = {
            pubkey: peerPubkey,
            connection: pc,
            channel: channel,
            connected: false,
        };

        // Handle data channel messages
        channel.onmessage = (event) => {
            this.handlePeerMessage(session, peer, event.data);
        };

        channel.onopen = () => {
            peer.connected = true;
            console.log(`Collaboration: Connected to peer ${peerPubkey.slice(0, 8)}...`);

            // Send initial sync
            this.sendSyncStep1(session, peer);
        };

        channel.onclose = () => {
            peer.connected = false;
            console.log(`Collaboration: Disconnected from peer ${peerPubkey.slice(0, 8)}...`);
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignalingMessage(session, peerPubkey, {
                    type: 'ice-candidate',
                    candidate: event.candidate,
                });
            }
        };

        session.peers.set(peerPubkey, peer);

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.sendSignalingMessage(session, peerPubkey, {
            type: 'offer',
            sdp: offer.sdp,
        });

        return peer;
    },

    // Handle incoming peer message
    async handlePeerMessage(session, peer, data) {
        try {
            // Decrypt the message with session key
            const sessionKey = this.sessionKeys.get(session.id);
            const decrypted = Crypto.decryptString(Crypto.base64ToBytes(data), sessionKey);
            const message = JSON.parse(decrypted);

            switch (message.type) {
                case 'sync-step-1':
                    await this.handleSyncStep1(session, peer, message);
                    break;
                case 'sync-step-2':
                    await this.handleSyncStep2(session, peer, message);
                    break;
                case 'update':
                    await this.handleUpdate(session, peer, message);
                    break;
                case 'awareness':
                    await this.handleAwareness(session, peer, message);
                    break;
            }
        } catch (err) {
            console.error('Collaboration: Failed to handle peer message:', err);
        }
    },

    // Send Yjs sync step 1
    sendSyncStep1(session, peer) {
        const stateVector = Y.encodeStateVector(session.yDoc);
        this.sendPeerMessage(session, peer, {
            type: 'sync-step-1',
            stateVector: Crypto.bytesToBase64(stateVector),
        });
    },

    // Handle Yjs sync step 1
    async handleSyncStep1(session, peer, message) {
        const stateVector = Crypto.base64ToBytes(message.stateVector);
        const diff = Y.encodeStateAsUpdate(session.yDoc, stateVector);
        const myStateVector = Y.encodeStateVector(session.yDoc);

        this.sendPeerMessage(session, peer, {
            type: 'sync-step-2',
            diff: Crypto.bytesToBase64(diff),
            stateVector: Crypto.bytesToBase64(myStateVector),
        });
    },

    // Handle Yjs sync step 2
    async handleSyncStep2(session, peer, message) {
        const diff = Crypto.base64ToBytes(message.diff);
        Y.applyUpdate(session.yDoc, diff);

        // Send our diff based on their state vector
        const theirStateVector = Crypto.base64ToBytes(message.stateVector);
        const ourDiff = Y.encodeStateAsUpdate(session.yDoc, theirStateVector);

        if (ourDiff.length > 0) {
            this.sendPeerMessage(session, peer, {
                type: 'update',
                update: Crypto.bytesToBase64(ourDiff),
            });
        }
    },

    // Handle Yjs update
    async handleUpdate(session, peer, message) {
        const update = Crypto.base64ToBytes(message.update);
        Y.applyUpdate(session.yDoc, update);
    },

    // Handle awareness update
    async handleAwareness(session, peer, message) {
        const update = Crypto.base64ToBytes(message.update);
        awarenessProtocol.applyAwarenessUpdate(session.awareness, update, peer.pubkey);
    },

    // Send encrypted message to peer
    sendPeerMessage(session, peer, message) {
        if (!peer.connected || !peer.channel) return;

        const sessionKey = this.sessionKeys.get(session.id);
        const encrypted = Crypto.encryptString(JSON.stringify(message), sessionKey);
        peer.channel.send(Crypto.bytesToBase64(encrypted));
    },

    // Send signaling message via Nostr
    async sendSignalingMessage(session, recipientPubkey, message) {
        // Encrypt signaling message with recipient's pubkey
        const encrypted = await Auth.nip04Encrypt(recipientPubkey, JSON.stringify({
            sessionId: session.id,
            ...message,
        }));

        // Create ephemeral signaling event
        const event = {
            kind: 4, // Encrypted DM
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['p', recipientPubkey],
                ['session', session.id],
            ],
            content: encrypted,
        };

        const signedEvent = await Auth.signEvent(event);
        await Auth.publishEvent(signedEvent);
    },

    // Save collaborative document
    async saveDocument(session) {
        const yText = session.yDoc.getText('content');
        const content = yText.toString();

        // Encode as UTF-8
        const encoder = new TextEncoder();
        const data = encoder.encode(content);

        // Create a new version
        await Versioning.createVersion(session.file, data, {
            versionNote: 'Collaborative edit',
            autoSave: false,
        });

        console.log('Collaboration: Document saved');

        return content;
    },

    // Auto-save collaborative document
    async autoSave(session) {
        const yText = session.yDoc.getText('content');
        const content = yText.toString();

        const encoder = new TextEncoder();
        const data = encoder.encode(content);

        await Versioning.autoSaveVersion(session.file, data);

        console.log('Collaboration: Auto-saved');
    },

    // End a collaborative session
    async endSession(fileId) {
        const session = this.sessions.get(fileId);
        if (!session) return;

        // Disconnect all peers
        for (const [pubkey, peer] of session.peers) {
            if (peer.channel) peer.channel.close();
            if (peer.connection) peer.connection.close();
        }

        // Clear awareness
        session.awareness.destroy();

        // Clear Yjs document
        session.yDoc.destroy();

        // Clear session key
        const sessionKey = this.sessionKeys.get(session.id);
        if (sessionKey) {
            Crypto.wipeKey(sessionKey);
            this.sessionKeys.delete(session.id);
        }

        // Remove from caches
        this.yDocs.delete(session.id);
        this.awareness.delete(session.id);
        this.sessions.delete(fileId);

        console.log(`Collaboration: Ended session ${session.id.slice(0, 8)}...`);
    },

    // Generate session ID
    generateSessionId(fileId) {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        const random = Crypto.bytesToHex(bytes);
        return `${fileId}:${random}`;
    },

    // Generate consistent user color from pubkey
    generateUserColor(pubkey) {
        // Hash pubkey to get color
        let hash = 0;
        for (let i = 0; i < pubkey.length; i++) {
            hash = pubkey.charCodeAt(i) + ((hash << 5) - hash);
        }

        // Convert to hue (0-360)
        const hue = Math.abs(hash) % 360;

        return `hsl(${hue}, 70%, 50%)`;
    },

    // Get active peers in a session
    getActivePeers(fileId) {
        const session = this.sessions.get(fileId);
        if (!session) return [];

        return Array.from(session.awareness.getStates())
            .filter(([clientId, state]) => state.user)
            .map(([clientId, state]) => state.user);
    },

    // Update cursor position
    updateCursor(fileId, position) {
        const session = this.sessions.get(fileId);
        if (!session) return;

        const localState = session.awareness.getLocalState();
        session.awareness.setLocalState({
            ...localState,
            cursor: position,
        });
    },

    // Share session key with a collaborator
    async inviteCollaborator(fileId, recipientPubkey) {
        const session = this.sessions.get(fileId);
        if (!session) {
            throw new Error('Session not found');
        }

        // Share the file first (includes file key)
        await Sharing.shareFile(session.file, recipientPubkey, {
            permission: Sharing.PERMISSION_EDIT,
        });

        // Send session invitation via signaling
        await this.sendSignalingMessage(session, recipientPubkey, {
            type: 'invite',
            fileName: session.file.name,
        });

        console.log(`Collaboration: Invited ${recipientPubkey.slice(0, 8)}... to session`);
    },

    // Join an existing session via invitation
    async joinSession(file, inviterPubkey) {
        // Accept the share first
        // This gives us access to the file key

        // Start our own session
        const session = await this.startSession(file);

        // Connect to the inviter
        await this.connectPeer(session, inviterPubkey);

        return session;
    },

    // Check if collaboration is supported for file type
    isCollaborativeFileType(mimeType) {
        const supportedTypes = [
            'text/plain',
            'text/markdown',
            'text/html',
            'application/json',
            'text/css',
            'text/javascript',
            'application/javascript',
        ];

        return supportedTypes.some(t => mimeType?.startsWith(t));
    },
};

// Placeholder for Yjs library (loaded from CDN)
// Y, awarenessProtocol will be defined when Yjs is loaded
