# Auth event validation: tasks

- [x] T1 Tests first: table of accepted/refused events per route (internal/auth/authevent_test.go)
- [x] T2 ValidateAuthEvent + middleware wiring; Bearer falls through to signer session
- [x] T3 Quota path uses verified pubkey (context for upload/delete; sig-verified for GET /api/quota)
- [x] T4 go test ./... and go vet pass; web client request shapes match (R4)
- [ ] T5 Merge, deploy, live probe: replay 401, correct NIP-98 passes auth
- [ ] T6 Impact per handler + log review reported to cloistr-orchestrator

Evidence T1-T4 (2026-10-05): GOWORK=off go vet ./... clean; go test ./... all ok (auth: 22-case table incl. public kind-0/1 replay refused; server: Blossom upload token refused on folders/shares, NIP-98 accepted).
