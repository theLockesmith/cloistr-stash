# Cloistr-Stash REST API Documentation

A comprehensive analysis of the Cloistr-Stash Blossom file storage server API endpoints.

## Overview

Cloistr-Stash is a Blossom-compatible file storage server with Nostr integration for metadata and authentication. It provides file storage, folder organization, sharing capabilities, and public links.

**Base URL**: Configurable (default: `http://localhost:8091`)

## Authentication

The API uses Nostr-based authentication with signed events:

- **Header**: `Authorization: Nostr <base64-encoded-signed-event>` or `X-Blossom-Auth: Nostr <base64-encoded-signed-event>`
- **Event Kind**: 24242 (Blossom auth event)
- **Required Tags**: `["t", "action"]`, `["expiration", "timestamp"]`

### Auth Levels
- **Public**: No authentication required
- **Authenticated**: Valid Nostr signature required
- **Authorized**: Authentication + whitelist/platform access required

## API Endpoints

### System Endpoints

| Endpoint | Method | Auth | Description | Response |
|----------|--------|------|-------------|----------|
| `/health` | GET | None | Health check | `{"status": "healthy"}` |
| `/metrics` | GET | None | Prometheus metrics | Text format |
| `/api/auth/status` | GET | None | Check auth status | Auth status object |

### File Operations

| Endpoint | Method | Auth | Description | Request | Response |
|----------|--------|------|-------------|---------|----------|
| `/api/files` | GET | None | List files for pubkey | `?pubkey=<hex>` | File list |
| `/api/files` | POST | Authorized | Upload file | Multipart form | File metadata |
| `/api/files/{sha256}` | GET | None | Get file metadata | - | File metadata |
| `/api/files/{sha256}` | DELETE | Authorized | Delete file | - | `{"status": "deleted"}` |
| `/api/files/{sha256}/download` | GET | None | Download file | - | Binary data |
| `/api/metadata` | POST | Authorized | Publish file metadata | Signed Nostr event | Event confirmation |

### Folder Operations

| Endpoint | Method | Auth | Description | Request | Response |
|----------|--------|------|-------------|---------|----------|
| `/api/folders` | GET | None | List folders for pubkey | `?pubkey=<hex>` | Folder list |
| `/api/folders` | POST | Authorized | Create folder | Signed Nostr event | Folder metadata |
| `/api/folders/{id}` | GET | None | Get folder metadata | `?pubkey=<hex>` | Folder metadata |
| `/api/folders/{id}` | DELETE | Authorized | Delete folder | Signed deletion event | `{"status": "deleted"}` |

### Share Operations

| Endpoint | Method | Auth | Description | Request | Response |
|----------|--------|------|-------------|---------|----------|
| `/api/shares` | GET | None | List shares for pubkey | `?pubkey=<hex>&type=all\|created\|received` | Share lists |
| `/api/shares` | POST | Authorized | Create file share | Signed Nostr event | Share metadata |
| `/api/shares/{id}` | DELETE | Authorized | Revoke share | Signed deletion event | `{"status": "revoked"}` |

### Public Links

| Endpoint | Method | Auth | Description | Request | Response |
|----------|--------|------|-------------|---------|----------|
| `/public/{id}` | GET | None | Public link access page | - | HTML page |
| `/api/public/{id}` | GET | None | Public link metadata | - | Link metadata |

### User Management

| Endpoint | Method | Auth | Description | Request | Response |
|----------|--------|------|-------------|---------|----------|
| `/api/quota` | GET | None | Get quota info | `?pubkey=<hex>` | Quota status |
| `/api/keyring` | GET | None | Get encrypted root key | `?pubkey=<hex>` | Encrypted key |

## Data Models

### FileMetadata
```json
{
  "sha256": "string",
  "name": "string",
  "size": number,
  "mime_type": "string",
  "folder_id": "string",
  "created_at": number,
  "deleted_at": number,
  "file_id": "string",
  "plaintext_hash": "string",
  "encrypted": boolean,
  "encrypted_size": number
}
```

### FolderMetadata
```json
{
  "id": "string",
  "name": "string",
  "parent_id": "string",
  "created_at": number,
  "encrypted_key": "string"
}
```

### ShareResponse
```json
{
  "id": "string",
  "file_id": "string",
  "file_sha256": "string",
  "file_name": "string",
  "file_size": number,
  "file_mime_type": "string",
  "owner_pubkey": "string",
  "recipient_pubkey": "string",
  "permission": "string",
  "expires_at": number,
  "created_at": number,
  "encrypted_content": "string"
}
```

### PublicLinkResponse
```json
{
  "id": "string",
  "sha256": "string",
  "file_name": "string",
  "file_size": number,
  "file_mime_type": "string",
  "expires_at": number,
  "max_downloads": number,
  "downloads": number,
  "created_at": number
}
```

### AuthResult
```json
{
  "authenticated": boolean,
  "pubkey": "string",
  "authorized": boolean,
  "error": "string"
}
```

### QuotaResponse
```json
{
  "enabled": boolean,
  "used": number,
  "limit": number,
  "available": number,
  "percent": number,
  "used_human": "string",
  "limit_human": "string"
}
```

## API Usage Examples

### 1. Check Authentication Status
```bash
curl -X GET http://localhost:8091/api/auth/status \
  -H "Authorization: Nostr <base64-encoded-event>"
```

### 2. List Files for User
```bash
curl -X GET "http://localhost:8091/api/files?pubkey=<user-pubkey-hex>"
```

### 3. Upload File
```bash
curl -X POST http://localhost:8091/api/files \
  -H "X-Blossom-Auth: Nostr <base64-encoded-event>" \
  -F "file=@example.txt"
```

### 4. Download File
```bash
curl -X GET http://localhost:8091/api/files/<sha256>/download \
  -o downloaded_file
```

### 5. Create Folder
```bash
curl -X POST http://localhost:8091/api/folders \
  -H "Authorization: Nostr <base64-encoded-event>" \
  -H "Content-Type: application/json" \
  -d '<signed-folder-creation-event>'
```

### 6. Get Quota Information
```bash
curl -X GET "http://localhost:8091/api/quota?pubkey=<user-pubkey-hex>"
```

## Error Handling

### HTTP Status Codes

| Code | Meaning | Usage |
|------|---------|-------|
| 200 | OK | Successful operation |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid parameters or request format |
| 401 | Unauthorized | Authentication required or invalid |
| 403 | Forbidden | Not authorized (not on whitelist) |
| 404 | Not Found | Resource doesn't exist |
| 405 | Method Not Allowed | HTTP method not supported |
| 409 | Conflict | Resource conflict (e.g., duplicate) |
| 422 | Payment Required | Service access required (platform mode) |
| 500 | Internal Server Error | Server error |
| 503 | Service Unavailable | External dependency unavailable |

### Error Response Format
```json
{
  "error": "error_code",
  "message": "Human-readable error message"
}
```

## Security Considerations

### 1. Authentication
- All write operations require valid Nostr signatures
- Events must not be expired (check `expiration` tag)
- Signatures are verified using Nostr cryptographic standards

### 2. Authorization
- **Standalone Mode**: Whitelist-based access control
- **Platform Mode**: Database-driven ACL via `user_service_access` table
- Empty whitelist = open access mode

### 3. Rate Limiting
- Configurable per-minute request limits
- Separate limits for uploads vs. general requests
- Burst capacity for traffic spikes

### 4. Input Validation
- SHA256 hashes validated for format
- File uploads limited by size
- Pubkey parameters validated as 64-character hex strings

### 5. Quota Management
- Per-user storage quotas (configurable)
- Usage calculated from Nostr relay metadata
- Quota checks before uploads

## Integration Points

### 1. Blossom Protocol
- Compatible with Blossom file storage specification
- Supports upload, download, delete operations
- Handles multiple encryption modes: none, server, e2e

### 2. Nostr Protocol
- File metadata stored as Nostr events (kind 30078)
- Folder metadata as Nostr events (kind 30079)
- File shares as Nostr events (kind 30080)
- Uses NIP-04 encryption for share content

### 3. Relay Integration
- Publishes metadata to configured Nostr relays
- Supports relay preference systems
- Handles relay connectivity gracefully

## Testing

### API Test Coverage

The API test suite covers:

1. **Endpoint Discovery** - All documented endpoints return appropriate status codes
2. **Authentication Flow** - Valid/invalid auth header handling
3. **File Operations** - Upload, download, list, delete workflows
4. **Folder Management** - CRUD operations for folder structure
5. **Share Operations** - Create, list, revoke file shares
6. **Public Links** - Anonymous access and metadata retrieval
7. **Quota Management** - Usage tracking and limits
8. **Error Handling** - Proper HTTP status codes and error messages
9. **Edge Cases** - Missing parameters, invalid formats, unavailable services

### Running Tests
```bash
# Run API integration tests
go test ./internal/server -v -run TestAPI

# Run specific test category
go test ./internal/server -v -run TestAPI_FileEndpoints
```

## Configuration

### Environment Variables
- `DRIVE_URL`: Server base URL
- `BLOSSOM_URL`: Backend Blossom server URL
- `NOSTR_PRIVATE_KEY`: Authentication key for testing
- `DRIVE_WHITELIST`: Comma-separated list of authorized pubkeys

### Config File (config.yml)
```yaml
server:
  host: localhost
  port: 8091
  public_url: http://localhost:8091

blossom:
  url: http://localhost:8085
  public_url: http://localhost:8085

relay:
  url: wss://relay.example.com

auth:
  pubkeys:
    - "pubkey1"
    - "pubkey2"
  whitelist_file: "/path/to/whitelist.txt"

quota:
  enabled: true
  default_limit: 1073741824  # 1GB

rate_limit:
  enabled: true
  requests_per_minute: 60
  burst_size: 10
  uploads_per_minute: 10

platform:
  enabled: false
  database_url: "postgres://..."
  service_id: "drive"
```

## Deployment Notes

### 1. Dependencies
- **Blossom Server**: Backend file storage
- **Nostr Relay**: Metadata persistence
- **PostgreSQL**: Platform ACL (optional)

### 2. Scaling Considerations
- Stateless design (metadata in relay, files in Blossom)
- Horizontal scaling supported
- Rate limiting per instance

### 3. Monitoring
- Prometheus metrics at `/metrics`
- Health check at `/health`
- Structured JSON logging

### 4. High Availability
- Graceful degradation when external services unavailable
- Retry logic for relay connections
- Circuit breaker patterns for Blossom communication

## API Versioning

Currently, the API does not use explicit versioning. Breaking changes should:

1. Maintain backward compatibility where possible
2. Add new optional fields rather than changing existing ones
3. Use new endpoints for fundamentally different operations
4. Document deprecation timeline for removed features

## Support and Contributing

For issues, feature requests, or contributions:

1. Check existing API tests for usage examples
2. Follow Nostr and Blossom protocol specifications
3. Ensure proper error handling and logging
4. Add test coverage for new endpoints
5. Update this documentation for API changes