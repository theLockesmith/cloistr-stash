# CLAUDE.md - cloistr-stash

**Zero-knowledge file manager with E2E encryption**

**Status:** Production | **Domain:** stash.cloistr.xyz

## Required Reading

| Document | Purpose |
|----------|---------|
| `~/claude/coldforge/cloistr/CLAUDE.md` | Cloistr project rules |
| `~/claude/coldforge/cloistr/services/stash/CLAUDE.md` | Full architecture spec |
| [docs/reference.md](docs/reference.md) | API, crypto, deployment |

## Autonomous Work Mode

**Work autonomously. Do NOT stop to ask what to do next.**

- Keep working until task complete or genuine blocker
- Make reasonable decisions - don't ask permission on obvious choices
- If tests fail, fix them. Use reviewer agent. Keep going.

## Agent Usage

| When | Agent |
|------|-------|
| Starting work / need context | `explore` |
| After significant code changes | `reviewer` |
| Writing/running tests | `test-writer` / `tester` |
| Security-sensitive code | `security` |

## Quick Commands

```bash
cp config.example.yml config.yml && go run ./cmd/server  # Run locally
go test ./...                                             # Run tests
npx playwright test                                       # E2E tests
docker build -t cloistr-stash .                           # Docker
atlas kube apply cloistr-stash --kube-context atlantis   # Deploy
```

## Project Structure

```
cmd/server/           Entry point
internal/
  auth/               NIP-07/NIP-46 auth
  blossom/            Blossom API client
  config/             Configuration
  metadata/           Nostr relay integration
  metrics/            Prometheus metrics
  server/             HTTP handlers
web/                  Frontend (vanilla JS)
  js/
    crypto.js         XChaCha20-Poly1305 + chunked
    keys.js           HKDF key derivation
    sharing.js        NIP-44 sharing, public links
    collaboration.js  Yjs CRDT + WebRTC
    search.js         Encrypted search index
tests/e2e/            Playwright tests
```

## Architecture Summary

```
User's Nostr Key → Root Key (encrypted) → Folder Keys → File Keys → XChaCha20 blobs → Blossom
```

| Component | Responsibility |
|-----------|---------------|
| Stash (client) | Encryption, key management, UI |
| Stash (server) | Share links, expiration, ACL |
| Blossom | Encrypted blob storage |
| Nostr relay | Folder/file metadata events |

## Completed Features

| Feature | Status |
|---------|--------|
| XChaCha20-Poly1305 client-side encryption | Done |
| NIP-07 / NIP-46 authentication | Done |
| NIP-44 file/folder sharing | Done |
| Public links (key-in-URL) | Done |
| Version history | Done |
| Yjs CRDT collaboration | Done |
| Encrypted search index | Done |
| Offline support (PWA) | Done |
| Chunked encryption (large files) | Done |
| Deduplication, batch ops, drag-drop | Done |
| Thumbnails, starred, recent, tags | Done |
| Mobile touch gestures | Done |
| Keyboard shortcuts | Done |
| Accessibility (ARIA) | Done |
| E2E tests (Playwright) | Done |
| Relay preferences | Done |

## Roadmap

| Item | Priority |
|------|----------|
| Desktop App (Tauri) | P1 |
| Mobile Apps | P2 |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET/POST/DELETE | `/api/files/*` | File operations |
| GET/POST/DELETE | `/api/folders/*` | Folder operations |
| GET/POST/DELETE | `/api/shares/*` | Share management |
| GET | `/public/{sha256}` | Public link access |
| POST | `/api/metadata` | Publish Nostr event |

**Full API:** See [docs/reference.md](docs/reference.md)

## Nostr Event Kinds

| Kind | Purpose |
|------|---------|
| 24242 | Blossom upload/delete auth |
| 30078 | Encrypted file metadata |
| 30079 | Encrypted folder metadata |
| 30080 | File/folder share |
| 30081 | Public share tracking |

## See Also

- [Desktop App Plan](docs/DESKTOP_APP.md)
- [Mobile App Plan](docs/MOBILE_APP.md)
- [NIP-46 Auth Flow](docs/NIP46_AUTH_FLOW.md)

---

**Last Updated:** 2026-03-25
