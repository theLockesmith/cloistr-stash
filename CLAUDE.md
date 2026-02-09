# CLAUDE.md - coldforge-drive

**Nostr-native file manager UI - Google Drive replacement**

## Documentation

Full documentation is maintained at:
`~/claude/coldforge/services/drive/CLAUDE.md`

This file exists to help Claude Code find context when working in this repository.

## What is Drive?

Drive is the **user-facing file manager application** that uses coldforge-blossom as its storage backend. Think of it like:
- **Blossom** = S3 (storage layer)
- **Drive** = Dropbox/Google Drive UI (file organization, sharing, folders)

Drive handles:
- File/folder organization (as Nostr events)
- Sharing with other npubs
- File metadata (names, descriptions, tags)
- Search and browsing UI

Blossom handles:
- Actual blob storage
- Upload/download
- Content addressing (SHA256)

## Status

**Active development** - Blossom backend is operational, building the Drive UI.

## Architecture

```
┌─────────────────────────────────────────┐
│           Browser (User)                │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│         coldforge-drive                 │
│                                         │
│  web/          → Frontend UI (HTML/JS)  │
│  internal/     → Go backend             │
│    blossom/    → Client SDK for Blossom │
│    metadata/   → Nostr event handling   │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│ coldforge-    │   │ Nostr Relay   │
│ blossom       │   │               │
│               │   │ (metadata     │
│ (file storage)│   │  events)      │
└───────────────┘   └───────────────┘
```

## Quick Reference

```bash
# Run locally
docker-compose up

# Run tests
go test ./...

# Build
docker build -t coldforge-drive .
```

## Project Structure

```
coldforge-drive/
├── cmd/server/main.go      # Entry point
├── internal/
│   ├── server/             # HTTP server (serves UI + API)
│   ├── blossom/            # Blossom client SDK
│   ├── metadata/           # File/folder Nostr events
│   ├── auth/               # NIP-46/NIP-07 auth
│   └── config/             # Configuration
├── web/                    # Frontend UI
│   ├── index.html
│   ├── css/
│   └── js/
└── config/                 # Config files
```

## Current Roadmap

1. **Blossom client SDK** - Go client to upload/download from Blossom
2. **Web frontend** - File browser with upload/download
3. **File upload flow** - Drag-and-drop → Blossom
4. **Folder management** - Create, rename, move folders (Nostr events)
5. **File metadata** - Names, descriptions, tags (Nostr events)
6. **Sharing** - Share files/folders with other npubs

## Agents

This repo has a `.claude` symlink pointing to `~/claude/coldforge/.claude`, which provides access to Coldforge-specific agents:
- **explore** - Research code and NIPs
- **docker** - Create/update Dockerfiles
- **atlas-deploy** - Kubernetes deployment via Atlas
- **service-init** - Scaffold new services

Global agents (reviewer, security, tester, test-writer, debugger, documenter) are always available.

## Autonomous Work Mode (CRITICAL)

**Work autonomously. Do NOT stop to ask what to do next.**

- Keep working until the task is complete or you hit a genuine blocker
- Make reasonable decisions - don't ask for permission on obvious choices
- If tests fail, fix them. If code needs review, use the reviewer agent. Keep going.
- Update documentation as you make progress

## See Also

- Blossom (storage): `~/claude/coldforge/services/blossom/CLAUDE.md`
- Drive service docs: `~/claude/coldforge/services/drive/CLAUDE.md`
- Coldforge Overview: `~/claude/coldforge/CLAUDE.md`
