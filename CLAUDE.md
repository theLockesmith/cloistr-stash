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
web/                  Frontend — MIGRATING vanilla JS -> React/Vite + @cloistr/ui
  index.html          Vite entry (React)
  vite.config.ts      React plugin + dedupe(react/react-dom/collab-common) + dev proxy->:8080
  src/                NEW React/TS source
    main.tsx          SharedAuthProvider + ToastProvider (from @cloistr/ui)
    App.tsx           Header/Footer/LoginPrompt chrome; useNostrAuth (collab-common)
  dist/               Vite build output — Go serves this (`server --web web/dist`)
  legacy/             OLD vanilla app (index.html, js/, css/, vendor/) — port source
    js/
      crypto.js       XChaCha20-Poly1305 + chunked   (port verbatim: keep cloistr-drive-* HKDF)
      keys.js         HKDF key derivation             (port verbatim)
      sharing.js      NIP-44 sharing, public links
      collaboration.js Yjs CRDT + WebRTC
      search.js       Encrypted search index
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
| Rebrand: Drive → Stash | Done |

## Roadmap

| Item | Priority | Where |
|------|----------|-------|
| Desktop App (Tauri) | P1 | `~/Development/cloistr-stash-desktop` |
| Mobile Apps | P2 | `~/Development/cloistr-stash-mobile` |

## Companion Repositories

These apps live in **separate sibling repos**, not in this tree. Don't overlook them when planning client work.

| Repo | Stack | How it reuses stash | Status |
|------|-------|---------------------|--------|
| `~/Development/cloistr-stash-desktop` | Tauri 2.0 (Rust backend) | **Symlinks this repo's `web/`** into the Tauri shell; bridges via `web/js/desktop.js` ↔ `window.desktopIntegration`. Web-wrapper pattern (like Discord/VS Code). | **On Hold** — paused pending web auth stabilization. Scaffold complete (crypto, API client, file watcher, sync queue, tray, keychain). |
| `~/Development/cloistr-stash-mobile` | **Flutter / Dart** (Riverpod, `sodium_libs`, Hive) | Independent rewrite — re-implements crypto natively, does **not** share JS. | Scaffold only. |

> **Stash has been migrated onto the suite-wide React + `@cloistr/ui` stack** (branch `migrate/stash-react-cloistr-ui`). `web/` is now a Vite + React 18 + TS app using `@cloistr/ui` (shared `Header`/`Footer`/`LoginPrompt`/`SharedAuthProvider`) over `@cloistr/collab-common` (NIP-46/NIP-07 auth, CRDT, sharing). `@cloistr/*` resolve from the aegis npm registry (`web/.npmrc`). The legacy vanilla app is preserved under `web/legacy/` as the verbatim port reference; the crypto/key/event layer was ported byte-for-byte (backward-compat anchors `cloistr-drive-*` intact, regression-tested). The Go server serves the Vite build: `server --web web/dist` (Dockerfile is multi-stage: node build → go build → runtime).
>
> **Desktop caveat (resolve before resuming desktop):** the desktop app symlinks this repo's `web/` and loads `web/js/desktop.js` ↔ `window.desktopIntegration`. This migration moved `desktop.js` to `web/legacy/js/`, and the React app does not load it — so desktop integration is currently broken. To resume: point the Tauri shell at the built `web/dist` (or run the Vite dev server) and port the `desktopIntegration` bridge into the React app (re-add `setApiAuth`/`clearApiAuth` calls on auth events). The Rust `set_api_auth`/`clear_api_auth` commands still exist.
>
> **E2E caveat:** `tests/e2e/` Playwright specs target the old vanilla DOM selectors and are stale against the React UI; they are not in CI. They need rewriting for the new component structure.

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

**Last Updated:** 2026-06-27

## Backward Compatibility Notes

The following identifiers are intentionally kept as `cloistr-drive-*` for backward compatibility with existing user data:

| Type | Value | Reason |
|------|-------|--------|
| IndexedDB | `cloistr-drive-keys` | User key storage |
| IndexedDB | `cloistr-drive-versions` | Version history |
| IndexedDB | `cloistr-drive-search` | Search index |
| HKDF Context | `cloistr-drive-root-v1` | Root key derivation |
| HKDF Context | `cloistr-drive-folder-v1` | Folder key derivation |
| HKDF Context | `cloistr-drive-file-v1` | File key derivation |
| HKDF Context | `cloistr-drive-share-v1` | Share key derivation |
| HKDF Context | `cloistr-drive-search-v1` | Search key derivation |
| HKDF Context | `cloistr-drive-collab-v1` | Collaboration key derivation |

**Changing these would break decryption of existing user files.**
