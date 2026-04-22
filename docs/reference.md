# cloistr-stash Reference

**Comprehensive reference documentation for the zero-knowledge file manager.**

For quick start and essential info, see [CLAUDE.md](../CLAUDE.md).

---

## Documentation Index

| Document | Content |
|----------|---------|
| [DESKTOP_APP.md](DESKTOP_APP.md) | Tauri desktop app plan |
| [MOBILE_APP.md](MOBILE_APP.md) | React Native/Flutter plan |
| [NIP46_AUTH_FLOW.md](NIP46_AUTH_FLOW.md) | NIP-46 authentication details |

---

## API Endpoints

### File Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files` | List files (query: pubkey, folder) |
| POST | `/api/files` | Upload file (requires whitelist) |
| GET | `/api/files/{sha256}` | Get file metadata |
| DELETE | `/api/files/{sha256}` | Delete file |
| GET | `/api/files/{sha256}/download` | Download file |

### Folder Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/folders` | List folders (query: pubkey, parent) |
| POST | `/api/folders` | Create folder |
| GET | `/api/folders/{id}` | Get folder metadata |
| DELETE | `/api/folders/{id}` | Delete folder |

### Share Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/shares` | List shares (query: pubkey, type) |
| POST | `/api/shares` | Create share |
| DELETE | `/api/shares/{id}` | Revoke share |

### Public Links

| Method | Path | Description |
|--------|------|-------------|
| GET | `/public/{sha256}` | Access public link (download page) |
| GET | `/api/public/{sha256}` | Get public link metadata (JSON) |

### Metadata & Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/metadata` | Publish Nostr metadata event |
| GET | `/api/auth/status` | Check auth status |

---

## Cryptographic Details

### Encryption

| Property | Value |
|----------|-------|
| Algorithm | XChaCha20-Poly1305 (libsodium) |
| Key length | 256 bits |
| Nonce | 192 bits (prepended to ciphertext) |
| MAC | Poly1305 (16 bytes) |

### Chunked Encryption (>10MB)

| Property | Value |
|----------|-------|
| Chunk size | 5MB (plaintext) |
| Format | `CLCH` (4) + version (1) + chunk_size (4) + count (4) + base_nonce (24) + chunks |
| Nonce derivation | XOR base_nonce with chunk index |
| Authentication | Per-chunk Poly1305 MAC |

### Key Derivation

| Key Type | Source |
|----------|--------|
| Root key | Random 256-bit, NIP-04 encrypted |
| Folder keys | Random OR HKDF from parent |
| File keys | HKDF(folder_key, file_id, "cloistr-stash-file-v1") |

### Key Storage

| Property | Value |
|----------|-------|
| Location | IndexedDB (per-browser) |
| Encryption | NIP-04 with user's own pubkey |
| Cache | In-memory Map, cleared on disconnect |

### Sharing

| Type | Method |
|------|--------|
| Private share | NIP-04/NIP-44 encrypted key exchange |
| Public link | Key in URL fragment (never sent to server) |

---

## Nostr Event Kinds

| Kind | Purpose |
|------|---------|
| 24242 | Blossom upload/delete authorization |
| 30078 | Encrypted file metadata |
| 30079 | Encrypted folder metadata |
| 30080 | File/folder share (NIP-04 encrypted) |
| 30081 | Public share (expiration tracking) |

---

## Security Considerations

1. **Zero-knowledge:** Server never sees plaintext or keys
2. **Key derivation:** HKDF ensures unique keys per file
3. **Forward secrecy:** Revocation re-encrypts with new keys
4. **Memory safety:** Keys wiped from memory after use
5. **URL fragments:** Never sent to server (browser security)
6. **Constant-time:** Key comparisons use constant-time operations

---

## CDN Dependencies

```html
<!-- Self-hosted with CDN fallback -->
<script src="/js/vendor/sodium.js"></script>
<script src="/js/vendor/yjs.min.js"></script>
<script src="/js/vendor/noble-secp256k1.min.js"></script>
```

| Library | File | Size |
|---------|------|------|
| libsodium (core) | `web/js/vendor/libsodium.js` | ~521KB |
| libsodium-wrappers | `web/js/vendor/sodium.js` | ~102KB |
| noble-curves | `web/js/vendor/noble-secp256k1.min.js` | ~40KB |
| Yjs | `web/js/vendor/yjs.min.js` | ~92KB |

---

## NIP-46 Authentication Notes

Remote signers (Amber, nsec.app) require special handling:

1. **Ephemeral client keypair**: Drive generates temp keypair for NIP-46 session
2. **NIP-42 relay auth**: Initially authenticated with client keypair
3. **Identity mismatch**: Published events use user's actual pubkey
4. **Lazy re-auth**: On first "restricted" error, re-authenticate with user's pubkey and retry

---

## Deployment

### ArgoCD GitOps

- **Namespace:** cloistr
- **Tunnel:** stash.cloistr.xyz via cloistr-tunnel
- **Config:** cloistr-config repository

### Atlas

```bash
atlas kube apply cloistr-stash --kube-context atlantis
```

---

## Testing

```bash
# Unit tests
go test ./...

# Crypto tests (browser console)
runCryptoTests()

# E2E tests
npx playwright test

# E2E with UI
npx playwright test --ui
```

---

## Relay Preferences Integration

Frontend `relayprefs.js` module implements full query chain:

1. `Auth.publishEvent()` uses user's preferred relays
2. Settings UI modal for viewing/editing preferences
3. Go backend uses `cloistr-common/relayprefs`
4. `metadata.Store.PublishToUserRelays()` for server-side publishing

See: `~/claude/coldforge/cloistr/architecture/relay-preferences.md`

---

**Last Updated:** 2026-03-11
