# Development Guide - coldforge-drive

This document provides guidance for developing the coldforge-drive file manager UI.

## Architecture Overview

Drive is a web application with a Go backend that:
1. Serves the frontend UI
2. Proxies file operations to coldforge-blossom
3. Manages file/folder metadata as Nostr events

```
┌─────────────────────────────────────────────────────────┐
│                    coldforge-drive                       │
│                                                          │
│  ┌──────────────────┐    ┌─────────────────────────┐    │
│  │   web/           │    │   internal/             │    │
│  │                  │    │                         │    │
│  │  - index.html    │◄──►│  server/   HTTP routes  │    │
│  │  - js/app.js     │    │  blossom/  Client SDK   │    │
│  │  - css/style.css │    │  metadata/ Nostr events │    │
│  └──────────────────┘    │  auth/     NIP-46/07    │    │
│                          │  config/   Settings     │    │
│                          └──────────┬──────────────┘    │
└─────────────────────────────────────┼───────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
           ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
           │   Blossom    │  │ Nostr Relay  │  │  Browser     │
           │   Server     │  │  (metadata)  │  │  Extension   │
           │              │  │              │  │  (NIP-07)    │
           └──────────────┘  └──────────────┘  └──────────────┘
```

## Package Structure

### cmd/server/
Entry point for the application:
- Configuration loading
- Service initialization
- HTTP server startup

### internal/server/
HTTP server and request handlers:
- Serve static files from `web/`
- API endpoints for file operations
- Proxy requests to Blossom

### internal/blossom/
Blossom client SDK:
- Upload files to Blossom server
- Download files from Blossom
- List files, check existence
- Handle auth headers

### internal/metadata/
Nostr event handling for file/folder metadata:
- Create file metadata events (kind 30078)
- Create folder events (kind 30079)
- Query relay for user's files
- Parse and validate events

### internal/auth/
Authentication handling:
- NIP-07 browser extension integration
- NIP-46 remote signing support
- Session management

### internal/config/
Configuration management:
- YAML file parsing
- Environment variable overrides
- Blossom URL, relay URL settings

### web/
Frontend UI:
- `index.html` - Main page
- `js/` - JavaScript application
- `css/` - Styles

## Development Workflow

### 1. Running Locally

```bash
# Start Blossom backend first
cd ../coldforge-blossom
docker-compose up -d

# Then start Drive
cd ../coldforge-drive
make run

# Or with Docker
docker-compose up
```

### 2. Frontend Development

The frontend is served from `web/`. For rapid iteration:

```bash
# Run Go server with file watching (if using air)
make dev

# Or just rebuild on changes
make build && ./bin/coldforge-drive
```

### 3. Testing

```bash
# Run all tests
make test

# Run with coverage
make test-coverage

# Test specific package
go test ./internal/blossom -v
```

## Key Interfaces

### Blossom Client

```go
type Client interface {
    // Upload sends a file to Blossom, returns SHA256 hash
    Upload(ctx context.Context, reader io.Reader, contentType string) (*UploadResult, error)

    // Download retrieves a file by hash
    Download(ctx context.Context, sha256 string) (io.ReadCloser, error)

    // Delete removes a file (requires auth)
    Delete(ctx context.Context, sha256 string, authEvent *nostr.Event) error

    // Exists checks if a file exists
    Exists(ctx context.Context, sha256 string) (bool, error)
}
```

### Metadata Store

```go
type MetadataStore interface {
    // SaveFile creates/updates a file metadata event
    SaveFile(ctx context.Context, file *FileMetadata) error

    // GetFile retrieves file metadata by ID
    GetFile(ctx context.Context, id string) (*FileMetadata, error)

    // ListFiles returns all files for a pubkey
    ListFiles(ctx context.Context, pubkey string) ([]*FileMetadata, error)

    // SaveFolder creates/updates a folder event
    SaveFolder(ctx context.Context, folder *FolderMetadata) error

    // ListFolders returns all folders for a pubkey
    ListFolders(ctx context.Context, pubkey string) ([]*FolderMetadata, error)
}
```

## API Endpoints

### File Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files` | List user's files |
| POST | `/api/files` | Upload a file |
| GET | `/api/files/:id` | Get file metadata |
| DELETE | `/api/files/:id` | Delete a file |
| GET | `/api/files/:id/download` | Download file content |

### Folder Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/folders` | List user's folders |
| POST | `/api/folders` | Create a folder |
| PUT | `/api/folders/:id` | Update folder |
| DELETE | `/api/folders/:id` | Delete folder |

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/challenge` | Get auth challenge |
| POST | `/api/auth/verify` | Verify signed event |

## Frontend Architecture

The frontend is vanilla JavaScript (no framework) for simplicity:

```
web/
├── index.html          # Main HTML
├── css/
│   └── style.css       # Styles
└── js/
    ├── app.js          # Main application
    ├── api.js          # API client
    ├── auth.js         # NIP-07 integration
    ├── upload.js       # File upload handling
    └── ui.js           # UI components
```

### NIP-07 Integration

```javascript
// Check for extension
if (window.nostr) {
    const pubkey = await window.nostr.getPublicKey();
    const signed = await window.nostr.signEvent(event);
}
```

## Common Tasks

### Adding a New API Endpoint

1. Add handler in `internal/server/`:
```go
func (s *Server) handleNewEndpoint(w http.ResponseWriter, r *http.Request) {
    // Implementation
}
```

2. Register route:
```go
mux.HandleFunc("POST /api/new-endpoint", s.handleNewEndpoint)
```

3. Add frontend API call in `web/js/api.js`:
```javascript
async function newEndpoint(data) {
    return fetch('/api/new-endpoint', {
        method: 'POST',
        body: JSON.stringify(data)
    });
}
```

### Implementing File Upload

1. Frontend captures file via input or drag-drop
2. Frontend calls POST /api/files with file data
3. Backend uploads to Blossom via client SDK
4. Backend creates file metadata Nostr event
5. Backend publishes event to relay
6. Backend returns file info to frontend

### Adding Nostr Event Support

1. Define event structure in `internal/metadata/types.go`
2. Implement create/parse functions
3. Add relay publish/query logic
4. Wire up to API handlers

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DRIVE_HOST` | Bind address | `0.0.0.0` |
| `DRIVE_PORT` | Server port | `8080` |
| `DRIVE_BLOSSOM_URL` | Blossom server URL | `http://localhost:8085` |
| `DRIVE_RELAY_URL` | Nostr relay URL | `wss://relay.damus.io` |
| `DRIVE_PUBLIC_URL` | Public URL for Drive | `http://localhost:8080` |

## Testing Strategy

### Unit Tests
- Test Blossom client with mock HTTP server
- Test metadata event creation/parsing
- Test auth verification

### Integration Tests
- Test full upload flow with real Blossom
- Test metadata persistence on relay
- Test auth flows

### E2E Tests
- Browser-based tests with Playwright/Cypress
- Test complete user flows

## Security Considerations

### Input Validation
- Validate file sizes (max upload limit)
- Sanitize file names
- Validate Nostr event signatures

### Authentication
- Verify NIP-07 signatures
- Check event timestamps
- Validate pubkey ownership

### CORS
- Configure allowed origins
- Protect API endpoints

## Debugging

### Check Blossom Connection
```bash
curl http://localhost:8085/health
```

### Test Upload Flow
```bash
# Upload via Drive
curl -X POST -F "file=@test.txt" http://localhost:8080/api/files

# Verify in Blossom
curl http://localhost:8085/<sha256>
```

### View Nostr Events
Use a Nostr client to query the relay for your pubkey's kind 30078/30079 events.

## Next Development Priorities

1. **Blossom Client SDK** - HTTP client for Blossom operations
2. **Basic Web UI** - File list and upload interface
3. **Metadata Events** - Nostr event creation/querying
4. **Folder Support** - Folder CRUD operations
5. **Auth Integration** - NIP-07 browser extension
6. **Sharing** - NIP-44 encrypted sharing

## Resources

- [Blossom Protocol](https://github.com/hzrd149/blossom)
- [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) - Browser Extension
- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) - Remote Signing
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) - Encryption
