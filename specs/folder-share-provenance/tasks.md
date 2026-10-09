# Folder share provenance: tasks

- [x] T1 Tests first: keys.folder-provenance.test.ts, folder-provenance.wiring.test.ts, sourceGuards (observed failing)
  - Evidence (2026-10-09): on unfixed code keys.folder-provenance 14 of 16 failed (the 2 passing are the accept-side cases), both new sourceGuards failed; the wiring file, once its mocks were hoisted, failed 2 of 2 with upload.ts/sharing.ts reverted to HEAD.
- [x] T2 Keys: provenance rule in importSharedFolderKey; resolveOwnFolderKey; restoreOwnFolderKeys
  - Evidence (2026-10-09): keys.folder-provenance.test.ts 16/16 pass.
- [x] T3 Wire: acceptShare ownership check; upload / shareFolder / migration use resolveOwnFolderKey; StashProvider uses restoreOwnFolderKeys
  - Evidence (2026-10-09): folder-provenance.wiring.test.ts 2/2 and the two sourceGuards pass; migration tests now give Keys an in-memory store (migration reads provenance).
- [ ] T4 typecheck, both suites, build, node proof; review
- [ ] T5 Live: poison a throwaway victim on the pre-fix build
- [ ] T6 Merge, deploy, live: self-repair + new upload wraps under the real key

## Residuals (orchestrator, 2026-10-09)

- [x] R-a importBackup through admitFolderKey; root/other keys never replaced
  - Evidence: keys.folder-residuals (a) 7 tests; on the old code with an IndexedDB stand-in 6 of 7 fail (old import overwrote an own folder key and the root key).
- [x] R-b re-derive subfolders of a repaired parent
  - Evidence: (b) 3 tests; 2 of 3 fail on old code (the third asserts nothing is touched).
- [x] R-c empty/failed ownership answer is unknown -> refuse; positive proof only
  - Evidence: keys.folder-provenance pre-provenance block + 3 wiring tests against a stubbed relay.
- [x] R-d untagged pre-provenance key that is not derived -> unverified, uploads refused, UI notice
  - Evidence: (d) 4 tests, 2 wiring upload tests, 2 sourceGuards.
- [ ] Review, MR, merge, deploy, live check
