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
       └── Folder Keys (HKDF derived)
                │
                └── File Keys (HKDF from folder + file_id)
                         │
                         └── Encrypted blobs → Blossom
```

| Component | Responsibility |
|-----------|---------------|
| Drive (client) | Encryption, key management, UI |
| Drive (server) | Share links, expiration, ACL |
| Blossom | Encrypted blob storage |
| Nostr relay | Folder/file metadata events |

### Key Features (Target Architecture)

| Feature | Approach |
|---------|----------|
| File encryption | Client-side XChaCha20-Poly1305, HKDF key derivation |
| Sharing | NIP-44 encrypted folder keys |
| Public links | Key in URL fragment (never sent to server) |
| Versioning | Linked encrypted blobs, same file key |
| Collaboration | Yjs CRDT + WebRTC + encrypted operations |
| Search | Client-side encrypted index per folder |
| Revocation | Full re-encrypt (cryptographically correct) |

### Current State

| Feature | Status |
|---------|--------|
| Basic file browser | **DONE** |
| NIP-07 auth | **DONE** |
| File upload | **DONE** (no encryption yet) |
| Client-side encryption | **PLANNED** |
| Folders | **PLANNED** |
| Sharing | **PLANNED** |
| Versioning | **PLANNED** |
| Collaboration | **PLANNED** |

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
    ├── css/
    └── js/
        ├── api.js          # API client
        ├── auth.js         # Nostr auth
        ├── upload.js       # Upload handling
        ├── ui.js           # UI rendering
        ├── app.js          # Main app
        ├── crypto.js       # (planned) Encryption
        ├── keys.js         # (planned) Key management
        └── sharing.js      # (planned) NIP-44 sharing
```

## Quick Commands

```bash
# Run locally
cp config.example.yml config.yml
go run ./cmd/server

# Run tests
go test ./...

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
