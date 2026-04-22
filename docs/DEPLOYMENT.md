# Cloistr Stash Deployment Guide

## Overview

Cloistr Stash is a Go server that serves a static web UI and connects to:
- **Blossom server**: For encrypted blob storage
- **Nostr relay**: For file metadata and sharing events

## Prerequisites

- Go 1.21 or later
- A Blossom server (e.g., cloistr-blossom)
- A Nostr relay (e.g., cloistr-relay or public relay)
- (Optional) Docker for containerized deployment

---

## Quick Start

### Local Development

```bash
# Clone the repository
git clone https://git.coldforge.xyz/coldforge/cloistr-stash.git
cd cloistr-stash

# Create configuration
cp config.example.yml config.yml
# Edit config.yml with your settings

# Run the server
go run ./cmd/server

# Access at http://localhost:8080
```

### Using Docker

```bash
# Build the image
docker build -t cloistr-stash .

# Run with environment variables
docker run -p 8080:8080 \
  -e DRIVE_BLOSSOM_URL=http://blossom:8085 \
  -e DRIVE_RELAY_URL=wss://relay.example.com \
  -e DRIVE_WHITELIST=pubkey1,pubkey2 \
  cloistr-stash
```

---

## Configuration

### Configuration File

Create a `config.yml` file:

```yaml
server:
  host: "0.0.0.0"
  port: 8080
  public_url: "https://drive.example.com"

blossom:
  url: "http://blossom:8085"        # Internal URL
  public_url: "https://blossom.example.com"  # Public URL for clients

relay:
  url: "wss://relay.example.com"

auth:
  whitelist_file: "/etc/drive/whitelist.txt"
  pubkeys:
    - "abc123..."  # Inline pubkeys

quota:
  enabled: true
  default_limit: 10737418240  # 10 GB in bytes
  data_file: "/var/lib/drive/quota.json"
  user_limits:
    "pubkey1": 107374182400  # 100 GB for specific user

rate_limit:
  enabled: true
  requests_per_minute: 120
  burst_size: 30
  uploads_per_minute: 10
```

### Environment Variables

All configuration can be overridden with environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DRIVE_HOST` | Server bind address | `0.0.0.0` |
| `DRIVE_PORT` | Server port | `8080` |
| `DRIVE_PUBLIC_URL` | Public URL for clients | `http://localhost:8080` |
| `DRIVE_BLOSSOM_URL` | Blossom server URL | `http://localhost:8085` |
| `DRIVE_BLOSSOM_PUBLIC_URL` | Public Blossom URL | (same as BLOSSOM_URL) |
| `DRIVE_RELAY_URL` | Nostr relay URL | `wss://relay.damus.io` |
| `DRIVE_WHITELIST` | Comma-separated pubkeys | (none) |
| `DRIVE_WHITELIST_FILE` | Path to whitelist file | (none) |
| `DRIVE_QUOTA_ENABLED` | Enable quota enforcement | `false` |
| `DRIVE_QUOTA_DEFAULT` | Default quota in bytes | `0` (unlimited) |
| `DRIVE_QUOTA_DATA_FILE` | Quota persistence file | (none) |
| `DRIVE_RATELIMIT_ENABLED` | Enable rate limiting | `false` |
| `DRIVE_RATELIMIT_REQUESTS` | Requests per minute | `120` |
| `DRIVE_RATELIMIT_BURST` | Max burst size | `30` |
| `DRIVE_RATELIMIT_UPLOADS` | Uploads per minute | `10` |

### Whitelist File Format

Create a text file with one pubkey per line:

```
# Comments are supported
abc123def456...  # User 1
789012ghi345...  # User 2
```

---

## Deployment Options

### 1. Systemd Service

Create `/etc/systemd/system/cloistr-stash.service`:

```ini
[Unit]
Description=Cloistr Stash Server
After=network.target

[Service]
Type=simple
User=drive
Group=drive
WorkingDirectory=/opt/cloistr-stash
ExecStart=/opt/cloistr-stash/server -config /etc/drive/config.yml -web /opt/cloistr-stash/web
Restart=always
RestartSec=5

# Environment
Environment=DRIVE_BLOSSOM_URL=http://localhost:8085
Environment=DRIVE_RELAY_URL=wss://relay.example.com

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable cloistr-stash
sudo systemctl start cloistr-stash
```

### 2. Docker Compose

```yaml
version: '3.8'

services:
  drive:
    image: ghcr.io/coldforge/cloistr-stash:latest
    ports:
      - "8080:8080"
    environment:
      - DRIVE_BLOSSOM_URL=http://blossom:8085
      - DRIVE_RELAY_URL=wss://relay:7777
      - DRIVE_WHITELIST_FILE=/etc/drive/whitelist.txt
      - DRIVE_QUOTA_ENABLED=true
      - DRIVE_QUOTA_DEFAULT=10737418240
    volumes:
      - ./whitelist.txt:/etc/drive/whitelist.txt:ro
      - ./quota.json:/var/lib/drive/quota.json
    depends_on:
      - blossom
      - relay

  blossom:
    image: ghcr.io/coldforge/cloistr-blossom:latest
    ports:
      - "8085:8085"
    volumes:
      - blossom-data:/data

  relay:
    image: ghcr.io/coldforge/cloistr-relay:latest
    ports:
      - "7777:7777"
    volumes:
      - relay-data:/data

volumes:
  blossom-data:
  relay-data:
```

### 3. Kubernetes

Example deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloistr-stash
  namespace: cloistr
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cloistr-stash
  template:
    metadata:
      labels:
        app: cloistr-stash
    spec:
      containers:
        - name: drive
          image: ghcr.io/coldforge/cloistr-stash:latest
          ports:
            - containerPort: 8080
          env:
            - name: DRIVE_BLOSSOM_URL
              value: "http://blossom:8085"
            - name: DRIVE_RELAY_URL
              value: "wss://relay:7777"
            - name: DRIVE_QUOTA_ENABLED
              value: "true"
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: cloistr-stash
  namespace: cloistr
spec:
  selector:
    app: cloistr-stash
  ports:
    - port: 80
      targetPort: 8080
```

---

## Reverse Proxy Configuration

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name drive.example.com;

    ssl_certificate /etc/ssl/certs/drive.crt;
    ssl_certificate_key /etc/ssl/private/drive.key;

    # Large file uploads
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for future features)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Static files caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        proxy_pass http://127.0.0.1:8080;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### Caddy

```caddyfile
drive.example.com {
    reverse_proxy localhost:8080 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }

    # Allow large uploads
    request_body {
        max_size 500MB
    }
}
```

### Traefik

```yaml
http:
  routers:
    drive:
      rule: "Host(`drive.example.com`)"
      service: drive
      tls:
        certResolver: letsencrypt

  services:
    drive:
      loadBalancer:
        servers:
          - url: "http://drive:8080"
```

---

## Monitoring

### Prometheus Metrics

Cloistr Stash exposes metrics at `/metrics`:

```prometheus
# File operations
drive_uploads_total{status="success"} 1234
drive_uploads_total{status="failure"} 12
drive_downloads_total{status="success"} 5678
drive_downloads_total{status="failure"} 34

# Upload sizes
drive_upload_bytes_total 123456789

# HTTP requests
drive_http_requests_total{method="GET", path="/api/files"} 1000
drive_http_request_duration_seconds{method="GET", path="/api/files"} 0.015
```

### Health Checks

```bash
# Basic health check
curl http://localhost:8080/health
# Returns: {"status":"healthy"}

# Check with monitoring
curl -f http://localhost:8080/health || alert "Drive is down"
```

### Logging

Logs are output in JSON format to stdout:

```json
{"level":"INFO","msg":"starting Drive server","address":"0.0.0.0:8080"}
{"level":"INFO","msg":"file uploaded","filename":"doc.pdf","sha256":"abc123","size":1024}
```

Configure log level via environment or config:
- `INFO` (default): Normal operation
- `DEBUG`: Verbose debugging
- `ERROR`: Errors only

---

## Security Considerations

### Network Security

1. **Run behind a reverse proxy** with TLS termination
2. **Use firewall rules** to restrict Blossom access to the Drive server
3. **Enable rate limiting** to prevent abuse

### Access Control

1. **Use the whitelist** to restrict who can upload
2. **Set reasonable quotas** to prevent storage abuse
3. **Monitor the activity log** for suspicious behavior

### Data Protection

1. **Backup quota data** (`quota.json`) regularly
2. **Backup Blossom storage** for file recovery
3. **Backup relay data** for metadata recovery

---

## Scaling

### Horizontal Scaling

Drive is stateless (except quota tracking) and can be scaled horizontally:

1. Deploy multiple instances behind a load balancer
2. Share quota data via:
   - Shared filesystem (NFS)
   - External database (planned)
   - Distributed cache (Redis, planned)

### Performance Tuning

```yaml
# Increase rate limits for high traffic
rate_limit:
  requests_per_minute: 300
  burst_size: 60
  uploads_per_minute: 30
```

### Resource Recommendations

| Deployment Size | CPU | Memory | Storage |
|-----------------|-----|--------|---------|
| Small (<100 users) | 1 core | 256 MB | 1 GB |
| Medium (<1000 users) | 2 cores | 512 MB | 5 GB |
| Large (>1000 users) | 4+ cores | 1+ GB | 10+ GB |

---

## Troubleshooting

### Server Won't Start

```bash
# Check if port is in use
lsof -i :8080

# Check config syntax
go run ./cmd/server -config config.yml 2>&1 | head -20
```

### Can't Connect to Blossom

```bash
# Test Blossom connectivity
curl http://blossom:8085/health

# Check DNS resolution
nslookup blossom
```

### Can't Connect to Relay

```bash
# Test WebSocket connection
websocat wss://relay.example.com

# Check relay logs
docker logs relay
```

### Quota Not Persisting

- Ensure `data_file` path is writable
- Check file permissions
- Verify volume mounts in Docker

---

## Upgrading

### Rolling Update (Kubernetes)

```bash
kubectl set image deployment/cloistr-stash \
  drive=ghcr.io/coldforge/cloistr-stash:v1.2.0
```

### Docker Compose

```bash
docker-compose pull
docker-compose up -d
```

### Manual Upgrade

```bash
# Build new binary
go build -o server ./cmd/server

# Stop old server
systemctl stop cloistr-stash

# Replace binary
cp server /opt/cloistr-stash/server

# Start new server
systemctl start cloistr-stash
```

---

## Support

- GitHub Issues: [github.com/coldforge/cloistr-stash/issues](https://github.com/coldforge/cloistr-stash/issues)
- Documentation: [docs/](.)
