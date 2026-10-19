# Tasks

- [x] T1 Server tests: list_files_auth_test.go (anonymous 401, other 403, own 200, wrong-request auth 401, GET by sha 401)
  - Evidence (2026-10-15): with server.go reverted, 4 of the 5 fail (own-200 passes either way).
- [x] T2 Server: handleListFiles checks the caller; GET /api/files/{sha256} behind RequireAuth
  - Evidence (2026-10-15): `GOWORK=off go test ./...` ok, golangci-lint 0 issues.
- [x] T3 Client: API.ownGet (cookie first, NIP-98 on 401), wired in authBridge
  - Evidence (2026-10-15): api.list.test.ts 3/3, sourceGuards guard; package 257/257, web 141/141, tsc and build clean.
- [ ] T4 Merge, deploy, live: anonymous 401, other pubkey 403, Drive UI lists own files
