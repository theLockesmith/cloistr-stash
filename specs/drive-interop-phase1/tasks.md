# Drive interop Phase 1 (Stash metadata): tasks

Each step is its own MR, stacked (orchestrator 2026-10-16). Nothing merges before !191 and !192.

- [x] T1 Codec: sealed file, folder and ring events; q and ring d (stash-core sealed.ts) (see evidence below)
- [x] T2 Reader: owner one-REQ listing + local tree, recipient #q listing, dual read; web lists from the relay (see evidence below)
- [ ] T3 Publish @cloistr/stash-core; test helper that builds a migrated file event
- [x] T4 Write paths: upload, rename, move, delete, new folder (random key), versions, tags (own MR stacked on !193) (see evidence below)
- [ ] T5 Stash embed for Space, exact-origin postMessage contract
- [ ] T6 Migration behind a flag, off until Space uses the embed; verify before kind 5, refuse on any unreadable file
- [ ] T7 Server: neutral upload filename; opaque pass-through
- [ ] T8 UI help text: S7 residue, including ring count and rewrite timing
- [ ] T9 Live probe with control

Evidence T1-T2 (2026-10-16): !193, commits c46e997, c8b4237, b0b43f0. sealed.test.ts (11) and drive.test.ts (10) written first and seen failing (module missing; null-root-key case failing with 9 vs 4), then passing; outsider test finds no name, id, folder, hash, type, size or tag in the events. stash-core 277/277, web 145/145, typecheck and `npm run build` clean. Live read-only parity: 3 production accounts, 17 files + 2 folders, new reader equal to the Go parser on every field.

Evidence T4 (2026-10-16): stash-core driveWrite.ts (writes) and sealedDrive.ts (which shape, keys from the last listing), wired through operations, upload, copy, versioning and the web provider. A sealed item is always edited sealed; a new item is sealed only when the drive's root ring exists; with the shape unknown (no root key, or sealed events but no root ring) every write refuses. driveWrite.test.ts (13) runs every operation into an in-memory relay and reads it back with the real reader, outsider test included; sealed-wiring.test.ts (3) goes through the app's operations. The owner-fallback test was seen failing before the reader change; the wiring test and the three security-review fixes (fresh owner wrap on every edit, tombstone blocks the owner fallback, no root ring means unknown) were each mutation-checked: fail without the fix, pass with it. stash-core 293/293, web 145/145, typecheck and `npm run build` clean. Residue for conscience: deleting a folder publishes one kind 5 naming the whole subtree, so the relay learns which deleted events belonged together.
