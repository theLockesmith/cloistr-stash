# CLAUDE.md - coldforge-files

**Blossom - Nostr-native file storage**

## Documentation

Full documentation is maintained at:
`~/claude/coldforge/services/files/CLAUDE.md`

This file exists to help Claude Code find context when working in this repository.

## Agents

This repo has a `.claude` symlink pointing to `~/claude/coldforge/.claude`, which provides access to Coldforge-specific agents:
- **explore** - Research code and NIPs
- **docker** - Create/update Dockerfiles
- **atlas-deploy** - Kubernetes deployment via Atlas
- **service-init** - Scaffold new services

Global agents (reviewer, security, tester, test-writer, debugger, documenter) are always available.

## Quick Reference

- **Run locally:** `docker-compose up`
- **Run tests:** `go test ./...`
- **Build:** `docker build -t coldforge-files .`

## Project Structure

- `cmd/server/main.go` - Entry point
- `internal/server/` - HTTP server and handlers
- `internal/storage/` - Storage interface and implementations
- `internal/auth/` - NIP-46 auth verification
- `internal/blossom/` - Blossom protocol types and logic
- `config/` - Configuration handling
- `tests/` - Integration tests

## See Also

- [Service Documentation](~/claude/coldforge/services/files/CLAUDE.md)
- [Coldforge Overview](~/claude/coldforge/CLAUDE.md)
