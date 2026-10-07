# @cloistr/stash-core: design

## Layout

`web/packages/stash-core/` as an npm workspace of `web/`. It lives inside
`web/` so the Docker build (`COPY web/`) and the CI frontend job (`cd web`)
keep working with one lockfile (`web/package-lock.json`).

`web/src/lib/*` moved there with `git mv` (history kept). The file/folder
domain types (`StashFile`, `StashFolder`, `WrappedKeyEntry`) moved from
`web/src/state/types.ts` to the package; the app re-exports them.

## Resolution

Package exports carry three conditions:

- `cloistr-source` -> `src/*.ts`. The web app (Vite, Vitest, tsc via
  `customConditions`) resolves this, so it builds from source with no
  pre-build step and HMR works. The condition name is deliberately unique:
  a plain `source` condition also matches nostr-tools, whose `source`
  export points at TS files it does not ship, and breaks the build.
- `types` / `import` -> `dist/`. Headless consumers get runnable ESM built
  by esbuild (bundle + splitting so singletons stay single) and `.d.ts` by
  tsc.

## Ports

- Signer: `connect({ signer })` takes anything structurally matching
  `SignerInterface` from `@cloistr/auth/core` (the React-free entry; the
  package never imports `@cloistr/auth`'s root, which pulls React context).
- Key storage: `connect({ storage })` -> `Keys.setStorage()`.
  `IndexedDBKeyStorage` stays the browser default; `InMemoryKeyStorage` and
  `FileKeyStorage` are the headless options.
- Endpoints: `apiBaseUrl` (Stash server) and `relayUrl` options; browser
  defaults unchanged (same-origin API, wss://relay.cloistr.xyz).

## FileKeyStorage overwrite rule

Records are stored self-encrypted with randomized NIP-44/NIP-04, so the
storage layer cannot compare key plaintext, and the same key re-stored
yields different ciphertext. `Keys.storeEncryptedKey` therefore checks
before writing, when the backend declares `refuseOverwrite: true`: if a
record exists and decrypts to DIFFERENT key bytes, or cannot be decrypted
at all, it throws `KeyOverwriteRefusedError`, mirroring Pages' keystore.
Re-storing the SAME key (re-wrap NIP-04 -> NIP-44, legacy base64 ->
encrypted) is allowed. Deliberate replacement passes `{ replace: true }`
(`rekey()` does) or calls `deleteKey` first.

The rule is opt-in per backend so the browser (IndexedDB) path keeps its
current behaviour in this change. Known hazard left as-is there, reported
separately: `getRootKey()` regenerates the root key when the stored one
cannot be decrypted, which silently replaces it.

FileKeyStorage itself enforces the permission half: atomic write via a
0600 temp file + rename, and an explicit chmod 0600, so a pre-existing
0644 file is tightened.
