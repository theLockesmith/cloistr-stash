# Development Guide - coldforge-files

This document provides guidance for developing the coldforge-files (Blossom) service.

## Architecture Overview

The service is structured in packages following Go best practices:

### cmd/server/
Entry point for the application. Handles:
- Environment variable loading (.env file)
- Configuration loading (YAML file)
- Storage backend initialization
- HTTP server startup

### internal/config/
Configuration management:
- YAML file parsing
- Environment variable overrides
- Sensible defaults
- Validation

### internal/storage/
Storage abstraction layer:
- `interface.go` - Backend interface contract
- `filesystem.go` - Filesystem implementation
- `filesystem_test.go` - Unit tests

Key design: All storage backends must implement the `Backend` interface, allowing pluggable storage (filesystem, Ceph, S3, etc.)

### internal/server/
HTTP server and request handlers:
- Route registration
- HTTP endpoint implementations
- Request validation
- Response formatting

### internal/auth/
NIP-46 authentication:
- Signature verification
- Token caching
- Authorization checking

### internal/blossom/
Blossom protocol types:
- Data structures for protocol compliance
- Request/response types

## Development Workflow

### 1. Writing Tests First

Always write tests before implementing features:

```go
// In internal/storage/filesystem_test.go
func TestMyNewFeature(t *testing.T) {
    // Setup
    tmpDir := t.TempDir()
    fs, _ := NewFilesystem(tmpDir)

    // Test
    result, err := fs.MyNewFeature()

    // Assert
    if err != nil {
        t.Fatalf("Expected success, got error: %v", err)
    }
}
```

### 2. Running Tests

```bash
# Run all tests
make test

# Run with coverage
make test-coverage

# Run with race detector
make test-race

# Run specific package
go test ./internal/storage -v
```

### 3. Building and Running

```bash
# Build binary
make build

# Run server
./bin/coldforge-files -config config/config.example.yml

# Or with Docker
make docker-build
docker-compose up
```

## Key Design Decisions

### Content-Addressed Storage

Files are addressed by SHA-256 hash, not filename:
- Same file uploaded twice = stored once (deduplication)
- File integrity verified by hash
- Portable across storage backends

### NIP-46 Authentication

Uses Nostr signing for all state-changing operations:
- Upload requires signed event
- Delete requires signed event from original uploader
- Server verifies signatures using Nostr protocol
- No centralized password storage

### Interface-Based Design

Storage backend is an interface:
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

This allows:
- Swapping implementations without changing API
- Testing with mock backends
- Multiple backend support (filesystem, Ceph, S3)

## Common Tasks

### Adding a New Endpoint

1. Add handler method to `internal/server/server.go`:
```go
func (s *Server) handleMyEndpoint(w http.ResponseWriter, r *http.Request) {
    // Validate input
    // Call storage backend
    // Write response
}
```

2. Register route in `registerRoutes()`:
```go
s.mux.HandleFunc("POST /my-endpoint", s.handleMyEndpoint)
```

3. Test with curl:
```bash
curl -X POST http://localhost:8080/my-endpoint
```

### Adding Storage Backend Support

1. Create new file: `internal/storage/ceph.go`
2. Implement `Backend` interface
3. Add instantiation logic to `cmd/server/main.go`
4. Add tests

Example:
```go
type Ceph struct {
    // Ceph client fields
}

func NewCeph(endpoint string) (*Ceph, error) {
    // Connect to Ceph
}

func (c *Ceph) Store(ctx context.Context, data io.Reader) (string, int64, error) {
    // Implementation
}

// ... other interface methods
```

### Adding Configuration Option

1. Add to `internal/config/config.go` struct:
```go
type Config struct {
    MyOption string `yaml:"my_option"`
}
```

2. Set default in `Load()`:
```go
cfg.MyOption = "default-value"
```

3. Add environment variable override:
```go
if val := os.Getenv("BLOSSOM_MY_OPTION"); val != "" {
    cfg.MyOption = val
}
```

4. Use in application:
```go
log.Printf("Option: %s", cfg.MyOption)
```

## Testing Strategy

### Unit Tests
- Test individual functions in isolation
- Use table-driven tests for multiple cases
- Mock external dependencies

### Integration Tests
- Test storage backends with real files
- Test HTTP endpoints end-to-end
- Test with actual config files

### Test Coverage Goals
- Aim for >80% coverage
- Cover happy path and error cases
- Test boundary conditions

## Error Handling

Follow Go error handling patterns:

```go
// Do not ignore errors
if err != nil {
    return fmt.Errorf("descriptive message: %w", err)
}

// Log errors at appropriate level
log.Printf("Warning: %v", err)

// HTTP error responses
if err != nil {
    http.Error(w, "User-friendly message", http.StatusInternalServerError)
    return
}
```

## Logging

Log important events but not excessively:

```go
log.Printf("File uploaded: %s (size: %d bytes)", sha256, size)
log.Printf("Error storing file: %v", err)
```

Avoid logging:
- Sensitive data (private keys, tokens)
- Excessive debug output
- Binary data

## Code Style

Follow Go conventions:
- `gofmt` for formatting
- Meaningful variable names
- Comments for exported functions
- Keep functions small and focused

```go
// VerifyEvent verifies that a Nostr event is properly signed
func (v *NIP46Verifier) VerifyEvent(ctx context.Context, event *nostr.Event) (bool, error) {
    // Implementation
}
```

## Dependencies

Current dependencies:
- `github.com/nbd-wtf/go-nostr` - Nostr protocol implementation
- `github.com/joho/godotenv` - Environment variable loading
- `gopkg.in/yaml.v3` - YAML parsing

Keep dependencies minimal. Before adding a new dependency:
1. Check if Go stdlib provides it
2. Prefer popular, well-maintained libraries
3. Check license compatibility (AGPL-3.0)

## Performance Considerations

### File Storage
- Use buffering for large files
- Implement streaming to avoid memory exhaustion
- Consider compression for small files

### Caching
- Cache validation results (token verification)
- Implement cache eviction (time-based or LRU)
- Make cache thread-safe with mutexes

### Concurrency
- Use context for timeouts and cancellation
- Protect shared state with mutexes
- Test with `-race` detector

## Security Considerations

### Input Validation
- Validate SHA256 hashes (length, hex format)
- Validate file sizes
- Validate pubkeys (length, format)

### NIP-46 Verification
- Always verify event signatures
- Check event timestamps (prevent replay)
- Validate event structure

### Access Control
- Only pubkey that uploaded can delete
- Implement rate limiting to prevent abuse
- Validate CORS headers if serving web clients

## Next Development Priorities

1. **NIP-46 Integration** - Full signature verification with relay
2. **File Metadata Tracking** - Track which pubkey uploaded which files
3. **Ceph Backend** - Production-grade storage
4. **Rate Limiting** - Prevent abuse
5. **Authorization Hooks** - Pluggable auth mechanisms
6. **Metrics** - Prometheus metrics for monitoring

## Debugging Tips

### Enable Verbose Logging
```bash
# In code
log.SetFlags(log.LstdFlags | log.Lshortfile)
```

### Test with curl
```bash
# Check server health
curl http://localhost:8080/health

# Upload file
curl -X PUT --data-binary @file.txt http://localhost:8080/upload

# Download file
curl http://localhost:8080/abc123... > downloaded.txt

# Check file exists
curl -I http://localhost:8080/abc123...
```

### Check Data Directory
```bash
# List stored files
ls -la data/

# Check file size
ls -lh data/ab/cdef123...
```

## Resources

- [Blossom Spec](https://github.com/hzrd149/blossom)
- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [Go Best Practices](https://golang.org/doc/effective_go)
- [Go Error Handling](https://go.dev/blog/error-handling-and-go)
