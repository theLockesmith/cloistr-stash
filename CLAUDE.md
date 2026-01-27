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
│   ├── server/             # HTTP server and handlers
│   ├── storage/            # Blossom client interface
│   ├── auth/               # NIP-46/NIP-07 auth
│   ├── metadata/           # File/folder Nostr events
│   └── config/             # Configuration
├── web/                    # Frontend UI (if embedded)
└── config/                 # Config files
```

## Status

This project was scaffolded but development focus shifted to coldforge-blossom first. Once Blossom is ready, Drive development will resume.

## Next Steps

1. Wait for coldforge-blossom to have basic functionality
2. Implement Blossom client SDK
3. Design folder/metadata Nostr event schema
4. Build file browser UI
5. Implement sharing

## See Also

- Blossom (storage): `~/claude/coldforge/services/files/CLAUDE.md`
- Drive service docs: `~/claude/coldforge/services/drive/CLAUDE.md` (to be created)
- Coldforge Overview: `~/claude/coldforge/CLAUDE.md`
