# coldforge-drive

Nostr-native file manager UI - a Google Drive replacement built on the Blossom protocol.

## Overview

Drive is the user-facing file management application for Coldforge. It provides:

- **File Browser** - Browse, search, and organize your files
- **Upload/Download** - Drag-and-drop uploads, direct downloads
- **Folder Organization** - Create folders, move files, organize content
- **Sharing** - Share files with other Nostr users (npubs)
- **Nostr-Native** - All metadata stored as Nostr events, files in Blossom

## Architecture

```
┌─────────────────────────────────────────┐
│              Browser                    │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │     Drive Web UI (web/)           │  │
│  │     - File browser                │  │
│  │     - Upload interface            │  │
│  │     - Folder management           │  │
│  └───────────────┬───────────────────┘  │
└──────────────────┼──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│         Drive Backend (Go)              │
│                                         │
│  - Serves web UI                        │
│  - Proxies to Blossom                   │
│  - Handles Nostr metadata events        │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│ coldforge-    │   │ Nostr Relay   │
│ blossom       │   │               │
│               │   │ (file/folder  │
│ (blob storage)│   │  metadata)    │
└───────────────┘   └───────────────┘
```

## Quick Start

### Prerequisites

- Go 1.22+
- Docker & Docker Compose
- Running coldforge-blossom instance

### Run Locally

```bash
# Start with docker-compose
docker-compose up

# Or build and run manually
make build
./bin/coldforge-drive
```

### Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DRIVE_HOST` | Bind address | `0.0.0.0` |
| `DRIVE_PORT` | Server port | `8080` |
| `DRIVE_BLOSSOM_URL` | Blossom server URL | `http://localhost:8085` |
| `DRIVE_RELAY_URL` | Nostr relay for metadata | `wss://relay.damus.io` |

## Features

### File Management
- Upload files via drag-and-drop or file picker
- Download files directly from Blossom
- Delete files (with Nostr auth)
- View file metadata (size, type, upload date)

### Folder Organization
- Create, rename, delete folders
- Move files between folders
- Nested folder structure
- Folder metadata as Nostr events (kind 30079)

### File Metadata
- File names and descriptions
- Tags for organization
- File metadata as Nostr events (kind 30078)
- Content-addressed storage (SHA-256)

### Sharing (Planned)
- Share with specific npubs (NIP-44 encrypted)
- Public shareable links
- Expiring links

## Project Structure

```
coldforge-drive/
├── cmd/server/main.go      # Entry point
├── internal/
│   ├── server/             # HTTP server
│   ├── blossom/            # Blossom client SDK
│   ├── metadata/           # Nostr event handling
│   ├── auth/               # NIP-46/NIP-07 auth
│   └── config/             # Configuration
├── web/                    # Frontend UI
│   ├── index.html
│   ├── css/
│   └── js/
├── config/
│   └── config.example.yml
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

## Development

```bash
# Run tests
make test

# Run with hot reload (requires air)
make dev

# Build Docker image
make docker-build

# Lint
make lint
```

## Nostr Event Schema

### File Metadata (Kind 30078)

```json
{
  "kind": 30078,
  "content": "",
  "tags": [
    ["d", "unique-file-id"],
    ["name", "document.pdf"],
    ["folder", "/work/reports/"],
    ["x", "sha256-hash"],
    ["url", "https://blossom.example.com/<sha256>"],
    ["m", "application/pdf"],
    ["size", "1234567"]
  ]
}
```

### Folder Metadata (Kind 30079)

```json
{
  "kind": 30079,
  "content": "",
  "tags": [
    ["d", "folder-id"],
    ["name", "reports"],
    ["path", "/work/reports/"],
    ["parent", "parent-folder-id"]
  ]
}
```

## Roadmap

- [x] Project structure
- [ ] Blossom client SDK
- [ ] Basic web UI (file list, upload)
- [ ] Folder management
- [ ] File metadata events
- [ ] Search
- [ ] Sharing

## Related Projects

- [coldforge-blossom](https://gitlab-coldforge/coldforge/coldforge-blossom) - Blob storage backend
- [Blossom Protocol](https://github.com/hzrd149/blossom) - Protocol specification

## License

AGPL-3.0
