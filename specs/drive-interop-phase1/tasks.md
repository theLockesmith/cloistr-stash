# Drive interop Phase 1 (Stash metadata): tasks

Each step is its own MR, stacked (orchestrator 2026-10-16). Nothing merges before !191 and !192.

- [x] T1 Codec: sealed file, folder and ring events; q and ring d (stash-core sealed.ts)
- [x] T2 Reader: owner one-REQ listing + local tree, recipient #q listing, dual read; web lists from the relay
- [ ] T3 Publish @cloistr/stash-core; test helper that builds a migrated file event
- [ ] T4 Write paths: upload, rename, move, delete, new folder (random key), versions, tags (own MR stacked on !193)
- [ ] T5 Stash embed for Space, exact-origin postMessage contract
- [ ] T6 Migration behind a flag, off until Space uses the embed; verify before kind 5, refuse on any unreadable file
- [ ] T7 Server: neutral upload filename; opaque pass-through
- [ ] T8 UI help text: S7 residue, including ring count and rewrite timing
- [ ] T9 Live probe with control

Evidence T1-T2 (2026-10-16): !193, commits c46e997, c8b4237, b0b43f0. sealed.test.ts (11) and drive.test.ts (10) written first and seen failing (module missing; null-root-key case failing with 9 vs 4), then passing; outsider test finds no name, id, folder, hash, type, size or tag in the events. stash-core 277/277, web 145/145, typecheck and `npm run build` clean. Live read-only parity: 3 production accounts, 17 files + 2 folders, new reader equal to the Go parser on every field.
