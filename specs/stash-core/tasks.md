# @cloistr/stash-core: tasks

- [x] T1 Move web/src/lib -> web/packages/stash-core/src; domain types into package
  - Evidence: `git status` shows web/src/lib/* as renames (R) to web/packages/stash-core/src/*; `StashFile`/`StashFolder`/`WrappedKeyEntry` in packages/stash-core/src/types.ts, re-exported from web/src/state/types.ts; `grep -rn "lib/" web/src` finds only two comments.
- [x] T2 Package manifest, source/import export conditions, esbuild + d.ts build
  - Evidence: `npm run build` in packages/stash-core: esbuild "Done" + tsc declarations, dist/index.js 1.7kb, dist/key-storage-file.js 1.4kb (2026-10-05).
- [x] T3 Web app: workspace dep, imports rewritten, Vite/Vitest/tsc resolve `cloistr-source`
  - Evidence: `npm run typecheck` clean (web + package); `npm test`: web 7 files / 115 tests passed, package 17 files / 131 tests passed; `npm run build`: "built in 59.56s", precache 25 entries (2026-10-05). node_modules/@cloistr/stash-core -> ../../packages/stash-core.
- [x] T4 `connect()` entry taking SignerInterface + KeyStorage + endpoints
  - Evidence: packages/stash-core/src/index.ts; signer-compat.test.ts proves `SignerInterface` (@cloistr/auth/core) is assignable to the port at compile time (tsc clean); node proof line "ok connect() with a local-key signer".
- [x] T5 FileKeyStorage 0600 (incl. tightening) + Keys overwrite refusal, tests first
  - Evidence: tests written first and observed failing (6 failures: perms 420!=384, 493!=448, refuseOverwrite undefined, no rejection), then passing after implementation: key-storage-file.test.ts, keys.overwrite.test.ts (8 tests). Migration headless tests (2) failed before the localStorage guard, pass after.
- [x] T6 Node proof: packed tarball, empty dir, no react, round trip
  - Evidence: `npm run proof:node` (2026-10-05): "ok react is NOT installed/resolvable" ... "ok root key restored from disk after restart", "ok file decrypts after restart", "ok overwriting a stored key with different material is refused", "PASS: @cloistr/stash-core runs in plain Node without React".
- [x] T7 Dockerfile + CI frontend job cover the package
  - Evidence: Dockerfile copies packages/stash-core/package.json before `npm ci`; .gitlab-ci.yml marker scan covers packages/*/src (yaml.safe_load ok); local `docker build --target web-builder` result recorded at ship time.
- [ ] T8 Ship: MR, merge, deploy, live check of stash.cloistr.xyz
