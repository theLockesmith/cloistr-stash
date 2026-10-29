# Tasks

- [x] T1 Tests: degraded_test.go (no store, silent relay, never connected -> 503 on 6 routes; /ready), reconnect_test.go (KeepConnected recovers; lists tell nothing from no answer)
  - Evidence (2026-10-15): with the previous server.go, 10 route checks return 200 with an empty list.
- [x] T2 Store: KeepConnected, IsConnected, EOSE-or-error lists, ErrFolderNotFound, nil-safe reconnect; main keeps the store, long-lived ctx
  - Evidence (2026-10-15): go test ./... ok, golangci-lint 0 issues.
- [x] T3 Server: storeUnavailable 503 on every data route, /ready, WatchBlossom
- [ ] T4 cloistr-config: readinessProbe -> /ready; merge, deploy, live /ready 200
