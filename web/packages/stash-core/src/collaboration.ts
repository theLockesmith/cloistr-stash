// Verbatim port from legacy/js/collaboration.js
// Real-time collaborative editing with Yjs CRDT + custom WebRTC-over-Nostr signaling.
//
// PRESERVED: HKDF context 'cloistr-drive-collab-v1' (used in
//   Keys.deriveKey(fileKey, 'session', 'cloistr-drive-collab-v1')).
// PRESERVED: WebRTC signaling message formats (offer/sdp, ice-candidate/candidate,
//   invite/fileName) and Nostr signaling event structure (kind 4 DM,
//   tags: [['p', recipientPubkey], ['session', sessionId]]).
//
// NOTE: y-protocols (awarenessProtocol) is not installed; all sessions run in
//   soloMode (awareness always null, no cursor/presence). When y-protocols is
//   added, restore the awarenessProtocol.Awareness instantiation block in
//   startSession and wire awareness.on('change') in startWebRTCProvider.
//
// Signaling: custom WebRTC over Nostr (NOT y-webrtc). The Relay module is
//   available for relay access but the setupNostrSignaling stub is ready to
//   be wired to a live subscription when the signaling flow is implemented.

import * as Y from 'yjs'
import { Keys } from './keys'
import { authPort } from './authBridge'
import { Crypto } from './crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a file object as used across the legacy app. */
export interface CollabFile {
  file_id?: string
  fileId?: string
  d?: string
  folder_id?: string
  folderId?: string
  folder?: string
  name?: string
}

/** A connected WebRTC peer. */
export interface CollabPeer {
  pubkey: string
  connection: RTCPeerConnection
  channel: RTCDataChannel
  connected: boolean
}

/** User presence info derived from pubkey. */
export interface CollabUser {
  pubkey: string
  name: string
  color: string
}

/** Local / remote awareness state shape (cursor position + user info). */
export interface CollabAwarenessState {
  user?: CollabUser
  cursor: unknown | null
}

/** A live collaborative editing session. */
export interface CollabSession {
  /** `${fileId}:${8-byte-hex-random}` */
  id: string
  fileId: string
  file: CollabFile
  yDoc: Y.Doc
  /** Reserved for y-protocols Awareness when installed; always null today. */
  awareness: null
  /** true when y-protocols is absent (always true until installed). */
  soloMode: boolean
  peers: Map<string, CollabPeer>
  provider: null
  editor: unknown | null
  startedAt: number
  callbacks: {
    onSync: ((session: CollabSession) => void) | null
    onAwarenessChange: ((changes: unknown, states: unknown) => void) | null
  }
}

/**
 * Optional port for legacy cross-module deps not yet ported:
 *   App.downloadFileData, Versioning.createVersion / autoSaveVersion,
 *   Sharing.shareFile.
 * Wire via Collaboration.configure() before calling startSession.
 */
export interface CollabDepsPort {
  downloadFileData?: (file: CollabFile) => Promise<Uint8Array | null>
  createVersion?: (
    file: CollabFile,
    data: Uint8Array,
    opts: { versionNote: string; autoSave: boolean },
  ) => Promise<void>
  autoSaveVersion?: (file: CollabFile, data: Uint8Array) => Promise<void>
  shareFile?: (
    file: CollabFile,
    recipientPubkey: string,
    opts: { permission: string },
  ) => Promise<void>
}

// ---------------------------------------------------------------------------
// Internal signaling message shapes (preserved from legacy exactly)
// ---------------------------------------------------------------------------

interface SignalingOffer {
  type: 'offer'
  sdp: string | undefined
}
interface SignalingIceCandidate {
  type: 'ice-candidate'
  candidate: RTCIceCandidate
}
interface SignalingInvite {
  type: 'invite'
  fileName: string | undefined
}
type SignalingPayload = SignalingOffer | SignalingIceCandidate | SignalingInvite

interface PeerMsgSyncStep1 {
  type: 'sync-step-1'
  stateVector: string
}
interface PeerMsgSyncStep2 {
  type: 'sync-step-2'
  diff: string
  stateVector: string
}
interface PeerMsgUpdate {
  type: 'update'
  update: string
}
interface PeerMsgAwareness {
  type: 'awareness'
  update: string
}
type PeerMessage = PeerMsgSyncStep1 | PeerMsgSyncStep2 | PeerMsgUpdate | PeerMsgAwareness

// ---------------------------------------------------------------------------
// Collaboration singleton
// ---------------------------------------------------------------------------

export const Collaboration = {
  // Active collaboration sessions
  sessions: new Map<string, CollabSession>(),

  // WebRTC configuration (preserved from legacy)
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  } as RTCConfiguration,

  // Signaling relay handle (wired when setupNostrSignaling is implemented)
  signalingRelay: null as unknown,
  signalingSubscription: null as unknown,

  // Session key for encrypting CRDT updates (keyed by sessionId)
  sessionKeys: new Map<string, Uint8Array>(),

  // Yjs documents (keyed by sessionId)
  yDocs: new Map<string, Y.Doc>(),

  // Awareness map reserved for y-protocols — always null today
  awareness: new Map<string, null>(),

  // Injected optional deps (App / Versioning / Sharing)
  deps: null as CollabDepsPort | null,

  configure(deps: CollabDepsPort): void {
    this.deps = deps
  },

  // Initialize collaboration
  async init(): Promise<void> {
    console.log('Collaboration: Initialized')
  },

  // Start a collaborative session for a file
  async startSession(
    file: CollabFile,
    options: {
      editorElement?: unknown
      onSync?: ((session: CollabSession) => void) | null
      onAwarenessChange?: ((changes: unknown, states: unknown) => void) | null
    } = {},
  ): Promise<CollabSession> {
    const { onSync = null, onAwarenessChange = null } = options

    // y-protocols not installed: always run in solo mode (no multi-user awareness)
    const soloMode = true
    console.warn(
      'Collaboration: y-protocols not loaded, running in solo mode (no multi-user awareness)',
    )

    if (!authPort.isConnected) {
      throw new Error('Not connected')
    }

    const fileId = file.file_id || file.fileId || file.d
    if (!fileId) {
      throw new Error('Cannot collaborate: missing file ID')
    }

    // Check if session already exists
    if (this.sessions.has(fileId)) {
      return this.sessions.get(fileId)!
    }

    // Generate session ID
    const sessionId = this.generateSessionId(fileId)

    // Generate or derive session key for encrypting CRDT updates
    const sessionKey = await this.deriveSessionKey(file)
    this.sessionKeys.set(sessionId, sessionKey)

    // Create Yjs document
    const yDoc = new Y.Doc()
    this.yDocs.set(sessionId, yDoc)

    // Awareness: always null (y-protocols not installed)
    const awarenessInstance = null

    // Create session object
    const session: CollabSession = {
      id: sessionId,
      fileId: fileId,
      file: file,
      yDoc: yDoc,
      awareness: awarenessInstance,
      soloMode: soloMode,
      peers: new Map(),
      provider: null,
      editor: null,
      startedAt: Date.now(),
      callbacks: {
        onSync: onSync,
        onAwarenessChange: onAwarenessChange,
      },
    }

    // Start WebRTC provider
    await this.startWebRTCProvider(session)

    // Store session
    this.sessions.set(fileId, session)

    // Load initial content
    await this.loadInitialContent(session)

    console.log(`Collaboration: Started session ${sessionId.slice(0, 8)}...`)

    return session
  },

  // Derive session key from file key
  // PRESERVED: HKDF context 'cloistr-drive-collab-v1' — changing this breaks
  //   decryption of all existing collaborative CRDT update blobs.
  async deriveSessionKey(file: CollabFile): Promise<Uint8Array> {
    const fileId = file.file_id || file.fileId || file.d
    const folderId = file.folder_id || file.folderId || file.folder || null

    if (!fileId) {
      throw new Error('Cannot derive session key: missing file ID')
    }

    let fileKey: Uint8Array
    if (folderId) {
      fileKey = await Keys.deriveFileKey(folderId, fileId)
    } else {
      fileKey = await Keys.deriveRootFileKey(fileId)
    }

    // PRESERVED: context string 'cloistr-drive-collab-v1'
    const sessionKey = await Keys.deriveKey(fileKey, 'session', 'cloistr-drive-collab-v1')

    // Wipe file key from memory
    Crypto.wipeKey(fileKey)

    return sessionKey
  },

  // Start WebRTC provider for peer-to-peer sync
  async startWebRTCProvider(session: CollabSession): Promise<void> {
    // Use Nostr relay for signaling
    await this.setupNostrSignaling(session)

    // Listen for awareness changes (only if y-protocols is installed and awareness non-null)
    if (session.awareness) {
      // Wire awareness.on('change', ...) here when y-protocols is added
    }
  },

  // Setup Nostr relay for WebRTC signaling
  // Stub: subscribe to kind 4 ephemeral events tagged with session room
  async setupNostrSignaling(session: CollabSession): Promise<void> {
    console.log(
      `Collaboration: Setting up Nostr signaling for session ${session.id.slice(0, 8)}...`,
    )
  },

  // Load initial file content into Yjs document
  async loadInitialContent(session: CollabSession): Promise<void> {
    try {
      // Download and decrypt the file (via injected dep — App.downloadFileData in legacy)
      const decryptedData = this.deps?.downloadFileData
        ? await this.deps.downloadFileData(session.file)
        : null

      if (decryptedData) {
        const decoder = new TextDecoder()
        const content = decoder.decode(decryptedData)

        const yText = session.yDoc.getText('content')
        yText.insert(0, content)

        console.log('Collaboration: Loaded initial content')

        if (session.callbacks.onSync) {
          session.callbacks.onSync(session)
        }
      }
    } catch (err) {
      console.warn('Collaboration: Failed to load initial content:', err)
    }
  },

  // Bind Yjs document to a TipTap editor instance.
  // The editor must already be configured with the TipTap Collaboration extension
  // pointing to session.yDoc; this method just records the binding.
  bindToTipTap(session: CollabSession, editor: unknown): void {
    session.editor = editor
    console.log('Collaboration: Bound to TipTap editor')
  },

  // Bind Yjs document to a plain <textarea> element.
  // Bidirectional: textarea input -> Y.Text transact; Y.Text observe -> textarea value.
  bindToTextarea(session: CollabSession, textarea: HTMLTextAreaElement): void {
    const yText = session.yDoc.getText('content')

    // Initial value
    textarea.value = yText.toString()

    // Local changes -> Yjs
    textarea.addEventListener('input', () => {
      const currentValue = yText.toString()
      const newValue = textarea.value

      if (currentValue !== newValue) {
        // Simple full-replace (not optimal for large texts — mirrors legacy)
        session.yDoc.transact(() => {
          yText.delete(0, yText.length)
          yText.insert(0, newValue)
        })
      }
    })

    // Yjs changes -> textarea (preserves cursor position)
    yText.observe(() => {
      const newContent = yText.toString()
      if (textarea.value !== newContent) {
        const selStart = textarea.selectionStart
        const selEnd = textarea.selectionEnd
        textarea.value = newContent
        // Restore cursor position
        textarea.selectionStart = Math.min(selStart, newContent.length)
        textarea.selectionEnd = Math.min(selEnd, newContent.length)
      }
    })

    console.log('Collaboration: Bound to textarea')
  },

  // Connect to a peer via WebRTC (initiator side: creates offer + data channel)
  async connectPeer(session: CollabSession, peerPubkey: string): Promise<CollabPeer> {
    if (session.peers.has(peerPubkey)) {
      return session.peers.get(peerPubkey)!
    }

    const pc = new RTCPeerConnection(this.rtcConfig)

    // Data channel for Yjs CRDT sync
    const channel = pc.createDataChannel('yjs-sync', { ordered: true })

    const peer: CollabPeer = {
      pubkey: peerPubkey,
      connection: pc,
      channel: channel,
      connected: false,
    }

    // Handle data channel messages
    channel.onmessage = (event) => {
      void this.handlePeerMessage(session, peer, event.data as string)
    }

    channel.onopen = () => {
      peer.connected = true
      console.log(`Collaboration: Connected to peer ${peerPubkey.slice(0, 8)}...`)
      // Send initial Yjs sync
      this.sendSyncStep1(session, peer)
    }

    channel.onclose = () => {
      peer.connected = false
      console.log(`Collaboration: Disconnected from peer ${peerPubkey.slice(0, 8)}...`)
    }

    // Handle ICE candidates — send via Nostr signaling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void this.sendSignalingMessage(session, peerPubkey, {
          type: 'ice-candidate',
          candidate: event.candidate,
        })
      }
    }

    session.peers.set(peerPubkey, peer)

    // Create and send offer
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    // PRESERVED: signaling message format { type: 'offer', sdp }
    void this.sendSignalingMessage(session, peerPubkey, {
      type: 'offer',
      sdp: offer.sdp,
    })

    return peer
  },

  // Dispatch an incoming peer message
  async handlePeerMessage(session: CollabSession, peer: CollabPeer, data: string): Promise<void> {
    try {
      const sessionKey = this.sessionKeys.get(session.id)
      if (!sessionKey) throw new Error('No session key')

      const decrypted = Crypto.decryptString(Crypto.base64ToBytes(data), sessionKey)
      const message = JSON.parse(decrypted) as PeerMessage

      switch (message.type) {
        case 'sync-step-1':
          await this.handleSyncStep1(session, peer, message)
          break
        case 'sync-step-2':
          await this.handleSyncStep2(session, peer, message)
          break
        case 'update':
          await this.handleUpdate(session, peer, message)
          break
        case 'awareness':
          await this.handleAwareness(session, peer, message)
          break
      }
    } catch (err) {
      console.error('Collaboration: Failed to handle peer message:', err)
    }
  },

  // Send Yjs sync step 1 (state vector)
  sendSyncStep1(session: CollabSession, peer: CollabPeer): void {
    const stateVector = Y.encodeStateVector(session.yDoc)
    this.sendPeerMessage(session, peer, {
      type: 'sync-step-1',
      stateVector: Crypto.bytesToBase64(stateVector),
    })
  },

  // Handle Yjs sync step 1: respond with our diff + our state vector
  async handleSyncStep1(
    session: CollabSession,
    peer: CollabPeer,
    message: PeerMsgSyncStep1,
  ): Promise<void> {
    const stateVector = Crypto.base64ToBytes(message.stateVector)
    const diff = Y.encodeStateAsUpdate(session.yDoc, stateVector)
    const myStateVector = Y.encodeStateVector(session.yDoc)

    this.sendPeerMessage(session, peer, {
      type: 'sync-step-2',
      diff: Crypto.bytesToBase64(diff),
      stateVector: Crypto.bytesToBase64(myStateVector),
    })
  },

  // Handle Yjs sync step 2: apply their diff, send ours based on their state vector
  async handleSyncStep2(
    session: CollabSession,
    peer: CollabPeer,
    message: PeerMsgSyncStep2,
  ): Promise<void> {
    const diff = Crypto.base64ToBytes(message.diff)
    Y.applyUpdate(session.yDoc, diff)

    const theirStateVector = Crypto.base64ToBytes(message.stateVector)
    const ourDiff = Y.encodeStateAsUpdate(session.yDoc, theirStateVector)

    if (ourDiff.length > 0) {
      this.sendPeerMessage(session, peer, {
        type: 'update',
        update: Crypto.bytesToBase64(ourDiff),
      })
    }
  },

  // Handle Yjs incremental update
  async handleUpdate(
    session: CollabSession,
    _peer: CollabPeer,
    message: PeerMsgUpdate,
  ): Promise<void> {
    const update = Crypto.base64ToBytes(message.update)
    Y.applyUpdate(session.yDoc, update)
  },

  // Handle awareness update (no-op: y-protocols not installed, always soloMode)
  async handleAwareness(
    session: CollabSession,
    _peer: CollabPeer,
    _message: PeerMsgAwareness,
  ): Promise<void> {
    if (session.soloMode || !session.awareness) {
      return
    }
    // awarenessProtocol.applyAwarenessUpdate(session.awareness, update, peer.pubkey)
    // Restore when y-protocols is installed.
  },

  // Send an encrypted message to a peer over the WebRTC data channel
  sendPeerMessage(
    session: CollabSession,
    peer: CollabPeer,
    message: Record<string, unknown>,
  ): void {
    if (!peer.connected || !peer.channel) return

    const sessionKey = this.sessionKeys.get(session.id)
    if (!sessionKey) return
    const encrypted = Crypto.encryptString(JSON.stringify(message), sessionKey)
    peer.channel.send(Crypto.bytesToBase64(encrypted))
  },

  // Send a WebRTC signaling message via Nostr (NIP-04 encrypted kind 4 DM)
  // PRESERVED: event shape { kind:4, tags:[['p',recipient],['session',id]], content }
  async sendSignalingMessage(
    session: CollabSession,
    recipientPubkey: string,
    message: SignalingPayload,
  ): Promise<void> {
    const encrypted = await authPort.nip04Encrypt(
      recipientPubkey,
      JSON.stringify({ sessionId: session.id, ...message }),
    )

    // Nostr signaling event format preserved verbatim from legacy
    const event = {
      kind: 4, // Encrypted DM
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', recipientPubkey],
        ['session', session.id],
      ],
      content: encrypted,
    }

    const signedEvent = await authPort.signEvent(event)
    await authPort.publishEvent(signedEvent)
  },

  // Save the collaborative document via Versioning (injected dep)
  async saveDocument(session: CollabSession): Promise<string> {
    const yText = session.yDoc.getText('content')
    const content = yText.toString()

    const encoder = new TextEncoder()
    const data = encoder.encode(content)

    if (this.deps?.createVersion) {
      await this.deps.createVersion(session.file, data, {
        versionNote: 'Collaborative edit',
        autoSave: false,
      })
    }

    console.log('Collaboration: Document saved')
    return content
  },

  // Auto-save the collaborative document
  async autoSave(session: CollabSession): Promise<void> {
    const yText = session.yDoc.getText('content')
    const content = yText.toString()

    const encoder = new TextEncoder()
    const data = encoder.encode(content)

    if (this.deps?.autoSaveVersion) {
      await this.deps.autoSaveVersion(session.file, data)
    }

    console.log('Collaboration: Auto-saved')
  },

  // End a collaborative session and release all resources
  async endSession(fileId: string): Promise<void> {
    const session = this.sessions.get(fileId)
    if (!session) return

    // Disconnect all peers
    for (const [, peer] of session.peers) {
      if (peer.channel) peer.channel.close()
      if (peer.connection) peer.connection.close()
    }

    // Clear awareness (only if y-protocols were active)
    if (session.awareness) {
      // awareness.destroy() — restore when y-protocols is installed
    }

    // Destroy Yjs document
    session.yDoc.destroy()

    // Wipe session key from memory
    const sessionKey = this.sessionKeys.get(session.id)
    if (sessionKey) {
      Crypto.wipeKey(sessionKey)
      this.sessionKeys.delete(session.id)
    }

    // Remove from caches
    this.yDocs.delete(session.id)
    if (session.awareness) {
      this.awareness.delete(session.id)
    }
    this.sessions.delete(fileId)

    console.log(`Collaboration: Ended session ${session.id.slice(0, 8)}...`)
  },

  // Generate session ID: `${fileId}:${8-byte-hex-random}`
  generateSessionId(fileId: string): string {
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    const random = Crypto.bytesToHex(bytes)
    return `${fileId}:${random}`
  },

  // Generate a consistent HSL color from a pubkey (same hash algorithm as legacy)
  generateUserColor(pubkey: string): string {
    let hash = 0
    for (let i = 0; i < pubkey.length; i++) {
      hash = pubkey.charCodeAt(i) + ((hash << 5) - hash)
    }
    const hue = Math.abs(hash) % 360
    return `hsl(${hue}, 70%, 50%)`
  },

  // Get active peers with user presence info
  getActivePeers(_fileId: string): CollabUser[] {
    // With y-protocols: return Array.from(session.awareness.getStates())
    //   .filter(([, state]) => state.user).map(([, state]) => state.user)
    // Stub until y-protocols is installed (always soloMode)
    return []
  },

  // Update local cursor position in awareness
  updateCursor(_fileId: string, _position: unknown): void {
    // With y-protocols: session.awareness.setLocalState({ ...localState, cursor: position })
    // Stub until y-protocols is installed
  },

  // Share session key with a collaborator via Sharing + signaling invite
  async inviteCollaborator(fileId: string, recipientPubkey: string): Promise<void> {
    const session = this.sessions.get(fileId)
    if (!session) {
      throw new Error('Session not found')
    }

    // Share the file (includes file key) via injected dep — Sharing.shareFile in legacy
    if (this.deps?.shareFile) {
      await this.deps.shareFile(session.file, recipientPubkey, { permission: 'edit' })
    }

    // Send session invitation via signaling
    // PRESERVED: invite message format { type: 'invite', fileName }
    await this.sendSignalingMessage(session, recipientPubkey, {
      type: 'invite',
      fileName: session.file.name,
    })

    console.log(`Collaboration: Invited ${recipientPubkey.slice(0, 8)}... to session`)
  },

  // Join an existing session via an invitation from another user
  async joinSession(file: CollabFile, inviterPubkey: string): Promise<CollabSession> {
    // Accept the share first (gives access to the file key via Sharing module)
    const session = await this.startSession(file)
    await this.connectPeer(session, inviterPubkey)
    return session
  },

  // Check if collaboration is supported for a given MIME type
  isCollaborativeFileType(mimeType?: string): boolean {
    const supportedTypes = [
      'text/plain',
      'text/markdown',
      'text/html',
      'application/json',
      'text/css',
      'text/javascript',
      'application/javascript',
    ]
    return supportedTypes.some((t) => mimeType?.startsWith(t))
  },
}

export type CollaborationModule = typeof Collaboration
export default Collaboration
