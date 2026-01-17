# coldforge-files - Blossom Server

A Nostr-native file storage server implementing the Blossom protocol. Files are stored with content-addressing (SHA-256 hash) and accessed via Nostr identity (NIP-46 signing).

## Overview

Blossom provides a simple HTTP API for file storage with Nostr-based authentication. Key features:

- **Content-Addressed Storage** - Files identified by SHA-256 hash
- **Automatic Deduplication** - Identical files stored once
- **NIP-46 Authentication** - Upload/delete requires signed Nostr events
- **Simple HTTP API** - GET to download, PUT to upload, DELETE to remove

## Quick Start

### Prerequisites

- Go 1.22+
- Docker & Docker Compose (optional)

### Run Locally

```bash
# Build
make build

# Run with default config
./bin/coldforge-files

# Run with custom config
./bin/coldforge-files -config path/to/config.yml
```

### Run with Docker

```bash
# Start with docker-compose
docker-compose up

# Or build and run manually
make docker-build
make docker-run
```

### Run Tests

```bash
# All tests
make test

# With coverage
make test-coverage

# With race detector
make test-race
```

## Configuration

Configuration can be set via YAML file or environment variables.

### YAML Configuration

```yaml
server:
  host: "0.0.0.0"
  port: 8080

storage:
  type: "filesystem"
  filesystem:
    path: "./data"

auth:
  relay_url: "wss://relay.example.com"

blossom:
  public_url: "https://blossom.example.com"
```

### Environment Variables

All configuration options can be set with environment variables:

- `BLOSSOM_HOST` - Server bind address (default: "0.0.0.0")
- `BLOSSOM_PORT` - Server port (default: 8080)
- `BLOSSOM_STORAGE_PATH` - Storage directory (default: "./data")
- `BLOSSOM_RELAY_URL` - NIP-46 relay URL
- `BLOSSOM_PUBLIC_URL` - Public URL for file downloads

## API Endpoints

### Health Check

```
GET /health
```

Returns server health status.

### Server Info

```
GET /info
```

Returns server information and capabilities.

### Upload File

```
PUT /upload
Content-Type: application/octet-stream
Authorization: Bearer <signed-event>

[file data]
```

Uploads a file. Returns SHA256 hash and public URL.

**Response:**
```json
{
  "url": "https://blossom.example.com/abc123...",
  "sha256": "abc123...",
  "size": 1024
}
```

### Download File

```
GET /<sha256>
```

Downloads a file by its SHA256 hash.

**Response:** File content with headers:
- `Content-Length` - File size
- `x-content-sha256` - SHA256 hash

### Check File Exists

```
HEAD /<sha256>
```

Check if a file exists without downloading it.

**Response:** 200 OK if exists, 404 if not found.

### Delete File

```
DELETE /<sha256>
Authorization: Bearer <signed-event>
```

Deletes a file. Requires authorization from the uploader.

**Response:**
```json
{
  "status": "deleted"
}
```

### List Files by Pubkey

```
GET /list/<pubkey>
```

Lists all files uploaded by a specific public key.

**Response:**
```json
{
  "files": [
    {"sha256": "abc123...", "size": 1024},
    {"sha256": "def456...", "size": 2048}
  ]
}
```

## Architecture

### Storage Backend

Currently supports:
- **Filesystem** - Local directory storage (for development)
- **Ceph** - Planned for production

Files are stored in a content-addressed structure:
```
data/
  ab/cdef123456.../    # First 2 chars of hash as directory
  xy/zzzzzzzzzzzzz...  # Remaining chars as filename
```

### Authentication

Uses NIP-46 (Nostr Connect) for authorization:

1. Client creates a Nostr event signing the request
2. Client includes event in Authorization header
3. Server verifies signature using Nostr protocol
4. If valid, request is processed

### Deduplication

Files are content-addressed by SHA256. When the same file is uploaded twice:

1. First upload: File stored with hash as key
2. Second upload: Hash calculated, same as first, file exists already
3. No duplicate storage, just return existing hash

## Project Structure

```
coldforge-files/
├── cmd/server/
│   └── main.go              # Entry point
├── internal/
│   ├── config/              # Configuration handling
│   │   └── config.go
│   ├── server/              # HTTP server and handlers
│   │   └── server.go
│   ├── storage/             # Storage interface and backends
│   │   ├── interface.go
│   │   ├── filesystem.go
│   │   └── filesystem_test.go
│   ├── auth/                # NIP-46 authentication
│   │   └── nip46.go
│   └── blossom/             # Blossom protocol types
│       └── types.go
├── config/
│   └── config.example.yml
├── Makefile
├── Dockerfile
├── docker-compose.yml
├── go.mod
├── go.sum
└── README.md
```

## Development

### Adding a New Feature

1. Write tests first (TDD approach)
2. Implement feature
3. Run tests: `make test`
4. Run linter: `make lint`
5. Commit with meaningful message

### Key Files

- **Storage Interface**: `internal/storage/interface.go` - Defines how storage backends work
- **HTTP Server**: `internal/server/server.go` - Handles all API endpoints
- **Authentication**: `internal/auth/nip46.go` - Verifies NIP-46 signatures

## Next Steps

- [ ] Implement full NIP-46 authorization verification
- [ ] Add Ceph storage backend
- [ ] Implement file metadata tracking (uploads by pubkey)
- [ ] Add storage quotas and rate limiting
- [ ] Support NIP-96 protocol
- [ ] Kubernetes deployment manifests

## Testing

The project includes unit tests for the filesystem storage backend. Add more tests as features are implemented:

```bash
# Run all tests
go test ./...

# Run specific package tests
go test ./internal/storage

# Run with coverage
go test -cover ./...

# Run with race detection
go test -race ./...
```

## References

- [Blossom Protocol](https://github.com/hzrd149/blossom)
- [NIP-46: Nostr Connect](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [NIP-94: File Metadata](https://github.com/nostr-protocol/nips/blob/master/94.md)

## License

AGPL-3.0 - See LICENSE file for details

## Development Notes

**Last Updated:** 2026-01-17

This is the initial scaffolding of the Blossom server. Key development areas:

1. NIP-46 authentication is stubbed out - needs integration with relay
2. File listing by pubkey needs metadata tracking
3. Storage backends need to be expanded (Ceph support)
4. Needs proper error handling and validation
5. Needs rate limiting and DoS protection
