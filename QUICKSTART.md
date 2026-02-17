# Quick Start Guide - coldforge-drive

## Prerequisites

- Go 1.22+ (for local development)
- Docker & Docker Compose (optional, for containerized development)
- git

## Clone and Setup

```bash
cd /home/forgemaster/Development/coldforge-drive

# Already initialized, just review structure:
ls -la

# View git history
git log --oneline
```

## Run Locally (Development)

### Option 1: Direct Go Binary

```bash
# Build the binary
make build

# Run with example config
./bin/coldforge-drive -config config/config.example.yml

# Server starts on http://localhost:8080
```

### Option 2: Docker Compose (Recommended)

```bash
# Start the server
docker-compose up

# In another terminal, test it:
curl http://localhost:8080/health

# View logs
docker-compose logs -f coldforge-drive

# Stop
docker-compose down
```

## Test the API

### Health Check
```bash
curl http://localhost:8080/health
# Response: {"status":"healthy"}
```

### Server Info
```bash
curl http://localhost:8080/info
# Returns: Server capabilities and version
```

### Upload a File
```bash
# Create a test file
echo "Hello, Blossom!" > test.txt

# Upload (note: auth is currently optional for development)
curl -X PUT --data-binary @test.txt http://localhost:8080/upload

# Response:
# {"url":"http://localhost:8080/abc123...","sha256":"abc123...","size":15}
```

### Download a File
```bash
# Use the SHA256 from upload response
curl http://localhost:8080/abc123... > downloaded.txt

# Verify content
cat downloaded.txt
```

### Check File Exists
```bash
# HEAD request returns just headers (no body)
curl -I http://localhost:8080/abc123...
# Returns: 200 OK if exists, 404 if not
```

### Delete a File
```bash
# Delete (note: auth is currently optional for development)
curl -X DELETE http://localhost:8080/abc123...
# Response: {"status":"deleted"}
```

## Run Tests

```bash
# All tests
make test

# With coverage report
make test-coverage

# With race detector (detects concurrency issues)
make test-race

# Specific package
go test ./internal/storage -v
```

## Project Structure Quick Reference

- **cmd/server/main.go** - Application entry point
- **internal/server/server.go** - HTTP handlers
- **internal/storage/filesystem.go** - File storage implementation
- **internal/auth/nip46.go** - Nostr authentication (stubbed)
- **internal/config/config.go** - Configuration management
- **Dockerfile** - Container build
- **Makefile** - Build targets

## Environment Variables

Configure via environment variables (override YAML):

```bash
export BLOSSOM_HOST=0.0.0.0
export BLOSSOM_PORT=8080
export BLOSSOM_STORAGE_PATH=/app/data
export BLOSSOM_RELAY_URL=wss://relay.damus.io
export BLOSSOM_PUBLIC_URL=http://localhost:8080

./bin/coldforge-drive
```

## Configuration File

Edit `config/config.example.yml`:

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

## Common Development Tasks

### View Build Artifacts
```bash
ls -la bin/
# Binary is at: bin/coldforge-drive
```

### Check Stored Files
```bash
# Files are stored with SHA256 hash as key
ls -la data/

# Structure: data/XX/yyzzz...
# Example: data/ab/cdef123456...
```

### Clean Build Artifacts
```bash
make clean
# Removes: bin/, dist/, coverage files
```

### Run Linter
```bash
make lint
# Requires golangci-lint to be installed
```

## Next Steps

1. **Understand the Code**
   - Read `DEVELOPMENT.md` for architecture
   - Read `README.md` for API documentation

2. **Implement NIP-46 Authentication**
   - Edit `internal/auth/nip46.go`
   - Connect to Nostr relay for signature verification
   - Update `internal/server/server.go` to verify auth

3. **Track File Uploads by Pubkey**
   - Modify `internal/storage/filesystem.go`
   - Store metadata about who uploaded each file
   - Implement `List()` method to return files by pubkey

4. **Add Ceph Backend**
   - Create `internal/storage/ceph.go`
   - Implement the `Backend` interface
   - Test with actual Ceph cluster

## Troubleshooting

### Port Already in Use
```bash
# Use a different port
BLOSSOM_PORT=8081 ./bin/coldforge-drive
```

### Permission Denied on Data Directory
```bash
# Create with proper permissions
mkdir -p data
chmod 755 data
```

### Go Compilation Error
```bash
# Ensure Go 1.22+ is installed
go version

# Download dependencies
go mod download
go mod tidy
```

## Key Features (Implemented)

✓ Content-addressed file storage (SHA-256)
✓ Automatic deduplication
✓ Filesystem storage backend
✓ HTTP API (GET/HEAD/PUT/DELETE)
✓ Configuration management
✓ Docker support
✓ Unit tests
✓ Concurrent access (thread-safe)

## Key Features (To Implement)

- [ ] NIP-46 relay integration
- [ ] File upload tracking by pubkey
- [ ] Ceph storage backend
- [ ] Rate limiting
- [ ] Storage quotas
- [ ] Kubernetes deployment

## Documentation

- **CLAUDE.md** - Quick reference
- **README.md** - Full API documentation
- **DEVELOPMENT.md** - Architecture and development guide
- **SCAFFOLDING-SUMMARY.md** - Detailed structure overview
- **QUICKSTART.md** - This file

## Getting Help

1. Check `DEVELOPMENT.md` for architecture details
2. Review code comments in the relevant module
3. Run tests to see examples of API usage
4. Check `README.md` for API endpoint documentation

## Version Info

- Go 1.22+
- gonostr v0.40.0
- yaml v3.0.1
- godotenv v1.5.1

---

**Ready to develop? Start with:**
```bash
make test          # Run tests to verify setup
make run           # Build and run the server
curl http://localhost:8080/health  # Test it
```
