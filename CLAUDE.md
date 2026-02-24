# CLAUDE.md - cloistr-drive

**Zero-knowledge file manager - Google Drive replacement with end-to-end encryption**

**Domain:** drive.cloistr.xyz

## REQUIRED READING (Before ANY Action)

**Claude MUST read these files at the start of every session:**

1. `~/claude/coldforge/cloistr/CLAUDE.md` - Cloistr project rules
2. `~/claude/coldforge/cloistr/services/drive/CLAUDE.md` - **Full Drive architecture documentation**

The services/drive/CLAUDE.md contains the complete zero-knowledge architecture specification.

## Quick Reference

### What is Drive?

Drive is the **user-facing file manager** that uses Blossom as storage. Think:
- **Blossom** = S3 (dumb blob storage)
- **Drive** = Google Drive UI (organization, sharing, collaboration)

**The key difference from Google Drive:** All encryption happens client-side. Coldforge cannot read user files.

### Architecture Summary

```
User's Nostr Key
       │
       └── Root Key (random, stored encrypted)
                │
                └── Folder Keys (HKDF derived OR random)
                         │
                         └── File Keys (HKDF from folder + file_id)
                                  │
                                  └── XChaCha20-Poly1305 encrypted blobs → Blossom
```

| Component | Responsibility |
|-----------|---------------|
| Drive (client) | Encryption, key management, UI |
| Drive (server) | Share links, expiration, ACL |
| Blossom | Encrypted blob storage |
| Nostr relay | Folder/file metadata events |

### Key Features

| Feature | Approach | Status |
|---------|----------|--------|
| File encryption | Client-side XChaCha20-Poly1305, HKDF key derivation | **DONE** |
| Sharing | NIP-44 encrypted folder/file keys | **DONE** |
| Public links | Key in URL fragment (never sent to server) | **DONE** |
| Versioning | Linked encrypted blobs, same file key | **DONE** |
| Collaboration | Yjs CRDT + WebRTC + encrypted operations | **DONE** |
| Search | Client-side encrypted index per user | **DONE** |
| Revocation | Full re-encrypt (cryptographically correct) | **DONE** |
| Expiring links | Time-limited shares with server validation | **DONE** |

### Current State

| Feature | Status |
|---------|--------|
| Basic file browser | **DONE** |
| NIP-07 auth | **DONE** |
| NIP-46 remote signer | **DONE** |
| File upload with encryption | **DONE** |
| File download with decryption | **DONE** |
| Client-side encryption (XChaCha20-Poly1305) | **DONE** |
| Key management (HKDF derivation) | **DONE** |
| Encrypted folders | **DONE** |
| NIP-44 file/folder sharing | **DONE** |
| Public links with key-in-URL | **DONE** |
| Expiring/timed shares | **DONE** |
| Revocation with re-encryption | **DONE** |
| Version tracking | **DONE** |
| Version history/restore | **DONE** |
| Yjs CRDT collaboration | **DONE** |
| WebRTC peer sync | **DONE** |
| Encrypted search index | **DONE** |
| Version history UI | **DONE** |
| Collaboration editor UI | **DONE** |
| Public link generation modal | **DONE** |
| Search integration | **DONE** |
| Key backup/recovery | **DONE** |
| Migration tool (unencrypted files) | **DONE** |
| Crypto progress indicators | **DONE** |
| Download counting | **DONE** |
| Share expiration validation | **DONE** |

## Project Structure

```
cloistr-drive/
├── cmd/server/main.go      # Entry point
├── internal/
│   ├── auth/               # NIP-07/NIP-46 auth, whitelist
│   ├── blossom/            # Blossom API client
│   ├── config/             # Configuration
│   ├── metadata/           # Nostr relay integration
│   ├── metrics/            # Prometheus metrics
│   └── server/             # HTTP handlers
└── web/                    # Frontend
    ├── index.html
    ├── css/style.css
    └── js/
        ├── api.js          # API client
        ├── auth.js         # Nostr auth + event signing
        ├── nip46.js        # NIP-46 remote signer
        ├── crypto.js       # XChaCha20-Poly1305 encryption
        ├── keys.js         # HKDF key derivation & management
        ├── sharing.js      # NIP-44 sharing, public links, revocation
        ├── versioning.js   # Version tracking & restore
        ├── collaboration.js # Yjs CRDT + WebRTC
        ├── search.js       # Encrypted search index
        ├── upload.js       # Encrypted upload handling
        ├── ui.js           # UI rendering
        ├── app.js          # Main app controller
        └── tests/
            └── crypto.test.js  # Crypto test suite
```

## Cryptographic Details

### Encryption
- **Algorithm:** XChaCha20-Poly1305 (libsodium)
- **Key length:** 256 bits
- **Nonce:** 192 bits (prepended to ciphertext)
- **Authentication:** Poly1305 MAC (16 bytes)

### Key Derivation
- **Algorithm:** HKDF-SHA256 (Web Crypto API)
- **Root key:** Random 256-bit, encrypted with user's Nostr key
- **Folder keys:** Random OR derived from parent via HKDF
- **File keys:** HKDF(folder_key, file_id, "cloistr-drive-file-v1")

### Key Storage
- **Location:** IndexedDB (per-browser)
- **Encryption:** NIP-04 with user's own pubkey
- **Cache:** In-memory Map, cleared on disconnect

### Sharing
- **Protocol:** NIP-04/NIP-44 encrypted key exchange
- **File share:** Encrypt file_key with recipient's pubkey
- **Folder share:** Encrypt folder_key with recipient's pubkey
- **Public links:** Key in URL fragment (never sent to server)

### Nostr Event Kinds
- **24242:** Blossom upload/delete authorization
- **30078:** Encrypted file metadata
- **30079:** Encrypted folder metadata
- **30080:** File/folder share (NIP-04 encrypted)
- **30081:** Public share (expiration tracking)

## API Endpoints

### File Operations
- `GET /api/files` - List files (query: pubkey, folder)
- `POST /api/files` - Upload file (requires whitelist)
- `GET /api/files/{sha256}` - Get file metadata
- `DELETE /api/files/{sha256}` - Delete file (requires whitelist)
- `GET /api/files/{sha256}/download` - Download file

### Folder Operations
- `GET /api/folders` - List folders (query: pubkey, parent)
- `POST /api/folders` - Create folder (requires whitelist)
- `GET /api/folders/{id}` - Get folder metadata
- `DELETE /api/folders/{id}` - Delete folder (requires whitelist)

### Share Operations
- `GET /api/shares` - List shares (query: pubkey, type)
- `POST /api/shares` - Create share (requires whitelist)
- `DELETE /api/shares/{id}` - Revoke share (requires whitelist)

### Public Links
- `GET /public/{sha256}` - Access public link (serves download page)
- `GET /api/public/{sha256}` - Get public link metadata (JSON)

### Metadata & Auth
- `POST /api/metadata` - Publish Nostr metadata event (requires whitelist)
- `GET /api/auth/status` - Check auth status

## Quick Commands

```bash
# Run locally
cp config.example.yml config.yml
go run ./cmd/server

# Run tests
go test ./...

# Run crypto tests (in browser console)
runCryptoTests()

# Build Docker
docker build -t cloistr-drive .
```

## Deployment

ArgoCD GitOps via cloistr-config:
- **Namespace:** cloistr
- **Tunnel:** drive.cloistr.xyz via cloistr-tunnel

```bash
# Deploy via Atlas
atlas kube apply cloistr-drive --kube-context atlantis
```

## CDN Dependencies

```html
<!-- libsodium for XChaCha20-Poly1305 -->
<script src="https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/sodium.js"></script>

<!-- Yjs for CRDT collaboration -->
<script src="https://cdn.jsdelivr.net/npm/yjs@13.6.10/dist/yjs.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/y-protocols@1.0.6/dist/y-protocols.min.js"></script>

<!-- Noble curves for Nostr crypto -->
<script type="module">
  import { schnorr, secp256k1 } from 'https://esm.sh/@noble/curves@1.6.0/secp256k1';
  // ...
</script>
```

## Security Considerations

1. **Zero-knowledge:** Server never sees plaintext or keys
2. **Key derivation:** HKDF ensures unique keys per file
3. **Forward secrecy:** Revocation re-encrypts with new keys
4. **Memory safety:** Keys wiped from memory after use
5. **URL fragments:** Never sent to server (browser security)
6. **Constant-time:** Key comparisons use constant-time operations

## Autonomous Work Mode

**Work autonomously. Do NOT stop to ask what to do next.**

- Read services/drive/CLAUDE.md for full architecture
- Follow the implementation phases documented there
- Make reasonable decisions without asking
- Update documentation as you make progress

## See Also

- **Full architecture:** `~/claude/coldforge/cloistr/services/drive/CLAUDE.md`
- **Blossom storage:** `~/Development/cloistr-blossom/CLAUDE.md`
- **Cloistr overview:** `~/claude/coldforge/cloistr/CLAUDE.md`
