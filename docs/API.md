# Cloistr Stash API Documentation

## Overview

Cloistr Stash provides a RESTful API for file management with Nostr-based authentication. The API supports file uploads, downloads, folder management, sharing, and public links.

## Base URL

- **Production:** `https://stash.cloistr.xyz`
- **Development:** `http://localhost:8080`

## Authentication

All authenticated endpoints require Nostr-based authentication using the `X-Blossom-Auth` or `Authorization` header.

### Blossom Auth Header Format

```
X-Blossom-Auth: Nostr <base64-encoded-signed-event>
```

The signed event must be a kind 24242 (Blossom auth) event with the following structure:

```json
{
  "kind": 24242,
  "pubkey": "<your-pubkey>",
  "created_at": <unix-timestamp>,
  "tags": [
    ["t", "<action>"],
    ["expiration", "<unix-timestamp>"]
  ],
  "content": "",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

Actions: `upload`, `delete`, `list`, `get`

---

## Endpoints

### Health Check

#### `GET /health`

Check server health status.

**Response:**
```json
{
  "status": "healthy"
}
```

---

### Authentication Status

#### `GET /api/auth/status`

Check authentication and authorization status.

**Headers:**
- `Authorization: Nostr <base64-encoded-signed-event>` (optional)

**Response:**
```json
{
  "authenticated": true,
  "authorized": true,
  "pubkey": "abc123...",
  "message": "Authenticated and authorized"
}
```

---

### Files

#### `GET /api/files`

List files for a pubkey.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pubkey` | string | Yes | Owner's public key (hex) |
| `folder` | string | No | Filter by folder ID (empty = root) |

**Response:**
```json
{
  "files": [
    {
      "sha256": "abc123...",
      "name": "document.pdf",
      "size": 1048576,
      "mime_type": "application/pdf",
      "folder_id": "",
      "created_at": 1708905600
    }
  ]
}
```

---

#### `POST /api/files`

Upload a file.

**Headers:**
- `X-Blossom-Auth: Nostr <base64-encoded-signed-event>` (required)

**Body:** `multipart/form-data`
- `file`: The file to upload

**Response:**
```json
{
  "sha256": "abc123...",
  "name": "document.pdf",
  "size": 1048576,
  "mime_type": "application/pdf"
}
```

**Error Responses:**
- `403 Forbidden`: Storage quota exceeded
- `401 Unauthorized`: Invalid or missing auth
- `413 Payload Too Large`: File exceeds size limit

---

#### `GET /api/files/{sha256}`

Get file metadata by SHA256 hash.

**Response:**
```json
{
  "sha256": "abc123...",
  "name": "document.pdf",
  "size": 1048576,
  "mime_type": "application/pdf"
}
```

---

#### `GET /api/files/{sha256}/download`

Download a file.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `public` | bool | No | Mark as public link download |
| `max_downloads` | int | No | Enforce download limit |

**Response:** Binary file content with appropriate `Content-Type` header.

---

#### `DELETE /api/files/{sha256}`

Delete a file.

**Headers:**
- `X-Blossom-Auth: Nostr <base64-encoded-signed-event>` (required)

**Response:**
```json
{
  "status": "deleted"
}
```

---

### File Metadata

#### `POST /api/metadata`

Publish file metadata to Nostr relay.

**Headers:**
- `Authorization: Nostr <base64-encoded-signed-event>` (required)

**Body:** Signed Nostr event (kind 30078)
```json
{
  "kind": 30078,
  "pubkey": "<owner-pubkey>",
  "created_at": 1708905600,
  "tags": [
    ["d", "<file-identifier>"],
    ["x", "<sha256-hash>"],
    ["m", "application/pdf"],
    ["size", "1048576"],
    ["folder", "<folder-id>"]
  ],
  "content": "{\"name\":\"document.pdf\"}",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

**Response:**
```json
{
  "status": "published",
  "event_id": "<event-id>"
}
```

---

### Folders

#### `GET /api/folders`

List folders for a pubkey.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pubkey` | string | Yes | Owner's public key (hex) |
| `parent` | string | No | Filter by parent folder ID |

**Response:**
```json
{
  "folders": [
    {
      "id": "folder-uuid",
      "name": "Documents",
      "parent_id": "",
      "created_at": 1708905600
    }
  ]
}
```

---

#### `POST /api/folders`

Create a new folder.

**Headers:**
- `Authorization: Nostr <base64-encoded-signed-event>` (required)

**Body:** Signed Nostr event (kind 30079)

**Response:**
```json
{
  "id": "folder-uuid",
  "name": "Documents",
  "parent_id": "",
  "created_at": 1708905600
}
```

---

#### `GET /api/folders/{id}`

Get folder metadata.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pubkey` | string | Yes | Owner's public key (hex) |

**Response:**
```json
{
  "id": "folder-uuid",
  "name": "Documents",
  "parent_id": "",
  "created_at": 1708905600
}
```

---

#### `DELETE /api/folders/{id}`

Delete a folder.

**Headers:**
- `Authorization: Nostr <base64-encoded-signed-event>` (required)

**Body:** Signed kind 5 deletion event

**Response:**
```json
{
  "status": "deleted"
}
```

---

### Sharing

#### `GET /api/shares`

List file shares.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pubkey` | string | Yes | User's public key (hex) |
| `type` | string | No | `created`, `received`, or `all` (default) |

**Response:**
```json
{
  "shares": [
    {
      "id": "share-uuid",
      "file_id": "file-uuid",
      "owner_pubkey": "abc123...",
      "recipient_pubkey": "def456...",
      "permission": "read",
      "expires_at": 1709510400,
      "created_at": 1708905600
    }
  ],
  "received": [
    {
      "id": "share-uuid",
      "file_id": "file-uuid",
      "owner_pubkey": "def456...",
      "recipient_pubkey": "abc123...",
      "permission": "read",
      "encrypted_content": "<NIP-04 encrypted share details>",
      "created_at": 1708905600
    }
  ]
}
```

---

#### `POST /api/shares`

Create a file share.

**Headers:**
- `Authorization: Nostr <base64-encoded-signed-event>` (required)

**Body:** Signed share event (kind 10078)

**Response:**
```json
{
  "id": "share-uuid",
  "file_id": "file-uuid",
  "owner_pubkey": "abc123...",
  "recipient_pubkey": "def456...",
  "permission": "read",
  "created_at": 1708905600
}
```

---

#### `DELETE /api/shares/{id}`

Revoke a file share.

**Headers:**
- `Authorization: Nostr <base64-encoded-signed-event>` (required)

**Body:** Signed kind 5 deletion event

**Response:**
```json
{
  "status": "revoked"
}
```

---

### Public Links

#### `GET /public/{sha256}`

Access a public link. Returns an HTML page with client-side decryption.

**URL Format:**
```
https://stash.cloistr.xyz/public/{sha256}#<base64url-encoded-key>
```

The decryption key is in the URL fragment and never sent to the server.

---

#### `GET /api/public/{sha256}`

Get public link metadata (JSON).

**Response:**
```json
{
  "id": "abc123...",
  "sha256": "abc123...",
  "file_name": "document.pdf",
  "file_size": 1048576,
  "file_mime_type": "application/pdf",
  "downloads": 5,
  "created_at": 1708905600
}
```

---

### Storage Quota

#### `GET /api/quota`

Get storage quota information.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pubkey` | string | Yes | User's public key (hex) |

**Response:**
```json
{
  "enabled": true,
  "used": 10485760,
  "limit": 1073741824,
  "available": 1063256064,
  "percent": 1,
  "used_human": "10.00 MB",
  "limit_human": "1.00 GB"
}
```

If quota is unlimited:
```json
{
  "enabled": true,
  "used": 10485760,
  "limit": 0,
  "available": -1,
  "percent": 0,
  "used_human": "10.00 MB",
  "limit_human": "Unlimited"
}
```

---

### Metrics

#### `GET /metrics`

Prometheus metrics endpoint.

**Response:** Prometheus text format

---

## Rate Limiting

When rate limiting is enabled, the API enforces the following limits:

- **General requests:** 120 requests/minute (configurable)
- **Uploads:** 10 uploads/minute (configurable)
- **Burst size:** 30 requests (configurable)

**Rate Limit Headers:**
- `Retry-After`: Seconds to wait before retrying
- `X-RateLimit-Limit`: Request limit per minute

**Response when limited:**
```
HTTP/1.1 429 Too Many Requests
Retry-After: 60

Rate limit exceeded
```

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "error_code",
  "message": "Human-readable error message"
}
```

**Common HTTP Status Codes:**
| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid auth |
| 403 | Forbidden - Not authorized or quota exceeded |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Backend unavailable |

---

## Nostr Event Kinds

| Kind | Description |
|------|-------------|
| 30078 | File metadata (parameterized replaceable) |
| 30079 | Folder metadata (parameterized replaceable) |
| 10078 | File share |
| 5 | Deletion event (NIP-09) |
| 24242 | Blossom authentication |

---

## Example: Upload Flow

1. **Generate auth event** (client-side):
```javascript
const authEvent = {
  kind: 24242,
  pubkey: myPubkey,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["t", "upload"],
    ["expiration", String(Math.floor(Date.now() / 1000) + 600)]
  ],
  content: ""
};
// Sign with NIP-07 or NIP-46
const signedEvent = await window.nostr.signEvent(authEvent);
```

2. **Upload file**:
```javascript
const formData = new FormData();
formData.append('file', fileBlob);

const response = await fetch('/api/files', {
  method: 'POST',
  headers: {
    'X-Blossom-Auth': 'Nostr ' + btoa(JSON.stringify(signedEvent))
  },
  body: formData
});
```

3. **Publish metadata** (optional):
```javascript
const metadataEvent = {
  kind: 30078,
  pubkey: myPubkey,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["d", fileId],
    ["x", sha256],
    ["m", mimeType],
    ["size", String(size)]
  ],
  content: JSON.stringify({ name: fileName })
};
const signedMetadata = await window.nostr.signEvent(metadataEvent);

await fetch('/api/metadata', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Nostr ' + btoa(JSON.stringify(authEvent))
  },
  body: JSON.stringify(signedMetadata)
});
```
