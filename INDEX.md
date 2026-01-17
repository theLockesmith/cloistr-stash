# coldforge-files - Complete Project Index

## Start Here

New to this project? Follow this order:

1. **QUICKSTART.md** (5 min read) - Get it running
2. **README.md** (10 min read) - Understand what it does
3. **DEVELOPMENT.md** (15 min read) - Understand how it works
4. **SCAFFOLDING-SUMMARY.md** (reference) - Detailed structure

## Documentation Files

| File | Purpose | Audience | Time |
|------|---------|----------|------|
| **CLAUDE.md** | Quick reference with agent info | Everyone | 2 min |
| **QUICKSTART.md** | Get the server running locally | Developers | 5 min |
| **README.md** | Complete API documentation | Everyone | 10 min |
| **DEVELOPMENT.md** | Architecture and patterns | Developers | 15 min |
| **SCAFFOLDING-SUMMARY.md** | Complete structure details | Architects | 20 min |
| **INDEX.md** | This file - navigation guide | Everyone | 3 min |

## Code Organization

```
coldforge-files/
├── cmd/
│   └── server/main.go           Entry point - Start here to understand flow
│
├── internal/
│   ├── config/config.go         How configuration is loaded and validated
│   ├── server/server.go         All HTTP endpoints are handled here
│   ├── storage/
│   │   ├── interface.go         The contract all storage backends must follow
│   │   └── filesystem.go        The actual file storage implementation
│   ├── auth/nip46.go            Nostr signature verification (needs completion)
│   └── blossom/types.go         Protocol types and structures
│
└── [tests, config, docs, etc.]
```

## Key Design Patterns

### 1. Storage Backend Interface (internal/storage/interface.go)

All storage must implement this interface. This allows:
- Swapping implementations (filesystem, Ceph, S3)
- Testing with mocks
- No API changes when switching backends

```go
type Backend interface {
    Store(ctx context.Context, data io.Reader) (sha256 string, size int64, err error)
    Retrieve(ctx context.Context, sha256 string) (io.ReadCloser, *FileInfo, error)
    Delete(ctx context.Context, sha256 string) error
    Exists(ctx context.Context, sha256 string) (bool, error)
    List(ctx context.Context, pubkey string) ([]FileInfo, error)
    GetSize(ctx context.Context, sha256 string) (int64, error)
}
```

### 2. Configuration Layering (internal/config/config.go)

Configuration flows in order of priority:
1. Hard-coded defaults
2. YAML file (if exists)
3. Environment variables (override everything)

This allows:
- Development with config files
- Production with environment variables
- Easy override in specific environments

### 3. Content-Addressed Storage

Files are identified by SHA-256 hash, not filename:
- Automatic deduplication
- Integrity verification
- Portable (same hash = same file)

## Important Files to Understand

### For API Understanding
- **README.md** - All endpoints documented
- **internal/server/server.go** - Where endpoints are implemented

### For Storage Understanding
- **internal/storage/interface.go** - Storage contract
- **internal/storage/filesystem.go** - How files are stored

### For Configuration Understanding
- **internal/config/config.go** - How config works
- **config/config.example.yml** - Example configuration

### For Authentication Understanding
- **internal/auth/nip46.go** - Nostr signature verification (stubbed)
- **README.md** - API authentication section

## Development Workflow

### 1. Understand the Current State
```bash
# Read the code to understand structure
cd /home/forgemaster/Development/coldforge-files
cat QUICKSTART.md      # Quick start
cat README.md          # API docs
cat DEVELOPMENT.md     # Architecture
```

### 2. Set Up Local Development
```bash
# Build the project
make build

# Run locally
./bin/coldforge-files -config config/config.example.yml

# Or with Docker
docker-compose up
```

### 3. Run Tests
```bash
# All tests
make test

# With coverage
make test-coverage

# With race detector
make test-race
```

### 4. Make Changes
```bash
# Edit code
vi internal/storage/filesystem.go

# Test your changes
go test ./internal/storage -v

# Build
make build

# Test with curl
curl http://localhost:8080/health
```

### 5. Commit Your Work
```bash
git add .
git commit -m "Descriptive message about changes"
```

## What Needs to be Done

### High Priority (Production Requirements)

1. **NIP-46 Authentication Integration** (internal/auth/nip46.go)
   - Connect to Nostr relay
   - Implement full signature verification
   - Cache tokens properly

2. **File Upload Tracking** (internal/storage/)
   - Store metadata about which pubkey uploaded each file
   - Implement per-pubkey file listing
   - Track timestamps

3. **Authorization Enforcement** (internal/server/server.go)
   - Verify upload requires valid Nostr signature
   - Verify delete requires uploader signature
   - Reject unauthorized requests

### Medium Priority (Important Features)

1. **Ceph Backend** (create internal/storage/ceph.go)
   - Implement Backend interface for Ceph
   - Test with actual Ceph cluster
   - Add configuration option

2. **Rate Limiting**
   - Limit requests per IP or pubkey
   - Prevent abuse and DoS

3. **Storage Quotas**
   - Per-user storage limits
   - Enforce size restrictions

### Lower Priority (Nice to Have)

1. **NIP-96 Support** - Alternative file protocol
2. **Prometheus Metrics** - Monitoring and observability
3. **Web UI** - File browser interface

## Testing

### Test Files
- **internal/storage/filesystem_test.go** - Storage tests

### Running Tests
```bash
# All tests
go test ./...

# With verbose output
go test -v ./...

# With coverage
go test -cover ./...

# Specific package
go test ./internal/storage -v
```

### Writing New Tests
1. Create `*_test.go` file in the same package
2. Write test functions starting with `Test`
3. Use table-driven tests for multiple cases
4. Run with `go test ./...`

Example:
```go
func TestMyFeature(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    fs, err := NewFilesystem(tmpDir)
    if err != nil {
        t.Fatalf("Setup failed: %v", err)
    }

    // Test
    result, err := fs.MyFeature()

    // Assert
    if err != nil {
        t.Errorf("Expected success, got: %v", err)
    }
}
```

## Configuration

### YAML File (config/config.example.yml)
```yaml
server:
  host: "0.0.0.0"
  port: 8080

storage:
  type: "filesystem"
  filesystem:
    path: "./data"

auth:
  relay_url: "wss://relay.damus.io"

blossom:
  public_url: "http://localhost:8080"
```

### Environment Variables
- `BLOSSOM_HOST` - Server bind address
- `BLOSSOM_PORT` - Server port
- `BLOSSOM_STORAGE_PATH` - Storage directory
- `BLOSSOM_RELAY_URL` - NIP-46 relay URL
- `BLOSSOM_PUBLIC_URL` - Public download URL

## API Quick Reference

### Endpoints
- `GET /health` - Health check
- `GET /info` - Server info
- `GET /<sha256>` - Download file
- `HEAD /<sha256>` - Check exists
- `PUT /upload` - Upload file
- `DELETE /<sha256>` - Delete file
- `GET /list/<pubkey>` - List files

See README.md for complete documentation.

## Dependencies

| Package | Version | Why |
|---------|---------|-----|
| go-nostr | v0.40.0 | Nostr protocol implementation |
| godotenv | v1.5.1 | Load .env files |
| yaml.v3 | v3.0.1 | Parse YAML configuration |

All Go standard library otherwise. No bloat.

## Project Stats

- **Total Lines of Code**: ~1,200 (without tests/docs)
- **Total Files**: 21
- **Packages**: 6 (5 internal + 1 cmd)
- **Test Functions**: 4
- **Documentation**: ~1,700 lines
- **Configuration Files**: 5

## Git Repository

All commits include detailed messages:

```bash
# View commit history
git log --oneline

# See what changed in a commit
git show <commit-hash>

# View all changes
git log -p
```

## Getting Help

1. **API Questions** - See README.md
2. **Architecture Questions** - See DEVELOPMENT.md
3. **Code Questions** - See comments in the relevant file
4. **Setup Questions** - See QUICKSTART.md
5. **Project Overview** - See SCAFFOLDING-SUMMARY.md

## Next Steps

### For Immediate Use
1. Read QUICKSTART.md
2. Run `make test` to verify setup
3. Run `make run` to start server
4. Test with curl

### For Development
1. Read DEVELOPMENT.md for architecture
2. Look at TODO sections in code comments
3. Implement high-priority items
4. Write tests for your changes
5. Commit frequently with clear messages

### For Production
1. Implement NIP-46 authentication
2. Add Ceph backend
3. Set up rate limiting
4. Configure monitoring
5. Deploy via GitLab CI/CD

## File Quick Links

| Path | Purpose |
|------|---------|
| cmd/server/main.go | Application entry point |
| internal/server/server.go | HTTP handlers |
| internal/storage/filesystem.go | File storage |
| internal/auth/nip46.go | Auth (needs work) |
| internal/config/config.go | Configuration |
| tests/ | Integration tests (empty) |
| Makefile | Build targets |
| Dockerfile | Container build |
| docker-compose.yml | Local dev setup |
| go.mod | Dependencies |

---

**Last Updated**: 2026-01-17
**Status**: Complete scaffolding, ready for development
**Next Task**: NIP-46 authentication integration
