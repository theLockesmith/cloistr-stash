# Tasks

- [x] T1 Tests: owner_only_test.go (8 route shapes x anonymous/other/own), authorigin_test.go (exact origin, replay, prune, middleware)
  - Evidence (2026-10-15): with !189's server.go, 10 owner-only assertions fail; with the origin check and replay disabled, the 3 NIP-98 tests fail.
- [x] T2 Server ownerOnly on folders/folder/shares/keyring; ValidateAuthHeaderOpts; ReplayCache; DRIVE_AUTH_ORIGINS; filename dropped from logs
  - Evidence (2026-10-15): go test ./... ok, golangci-lint 0 issues.
- [x] T3 Client: listFolders/getFolder/listShares/getKeyring via ownGet
  - Evidence (2026-10-15): api.list.test.ts 4/4, sourceGuards; package 258/258, web 141/141, tsc and build clean.
- [ ] T4 cloistr-config DRIVE_AUTH_ORIGINS; merge, deploy, live 401/403/200 per route
