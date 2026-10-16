# Tasks

- [x] T1 Tests first: cors_test.go (6), TestLoadCORSOrigins, TestCORSHeaders through New
  - Evidence (2026-10-15): with the middleware unwired, ListedOriginPreflight, ListedOriginGet and RateLimitedResponseKeepsHeaders fail.
- [x] T2 Middleware + config + wiring
  - Evidence (2026-10-15): `GOWORK=off go test ./internal/...` all ok; golangci-lint 0 issues.
- [ ] T3 cloistr-config: DRIVE_CORS_ORIGINS in the drive configmap
- [ ] T4 Merge, deploy, live: preflight + GET from space origin carry headers; unlisted origin gets none
