# --- Stage 1: build the React web UI (Vite) ---
FROM node:22-alpine AS web-builder

WORKDIR /web

# Registry config first for layer caching. @cloistr scope resolves from the
# aegis npm registry (anonymous read works; CI passes NPM_TOKEN=CI_JOB_TOKEN
# for authenticated pulls, matching the other Cloistr frontends).
COPY web/package.json web/package-lock.json web/.npmrc ./
ARG NPM_TOKEN=""
RUN if [ -n "$NPM_TOKEN" ]; then \
      echo "//git.coldforge.xyz/api/v4/projects/44/packages/npm/:_authToken=${NPM_TOKEN}" >> .npmrc; \
    fi
RUN npm ci

# Build the app -> /web/dist
COPY web/ ./
RUN npm run build

# --- Stage 2: build the Go server ---
FROM golang:1.25-alpine AS go-builder

WORKDIR /app
RUN apk add --no-cache git make

# Private Cloistr Go modules live on git.aegis-hq.xyz
ENV GOPRIVATE=git.aegis-hq.xyz
ENV GOINSECURE=git.aegis-hq.xyz

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/
RUN go build -o coldforge-drive ./cmd/server

# --- Stage 3: runtime ---
FROM alpine:latest

WORKDIR /app
RUN apk add --no-cache ca-certificates wget

# Go server binary
COPY --from=go-builder /app/coldforge-drive .

# Built web UI (Vite output). The Go server serves this with SPA fallback.
COPY --from=web-builder /web/dist /app/web

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["./coldforge-drive", "-config", "/app/config.yml", "-web", "/app/web"]
