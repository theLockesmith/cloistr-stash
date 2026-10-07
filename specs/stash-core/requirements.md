# @cloistr/stash-core: requirements

Source: conscience fleet plan, Stash steps 2 and 3
(`~/arbiter/conscience/specs/cloistr-apps-pages-stash-vault/requirements.md`),
routed by cloistr-orchestrator 2026-10-05.

R1. THE SYSTEM SHALL provide the Stash data layer (crypto, keys, events,
    relay, upload, sharing, operations) as a package `@cloistr/stash-core`
    with no React dependency.

R2. THE package SHALL take its signer as a `SignerInterface`
    (`@cloistr/auth/core`) and its key persistence as a `KeyStorage` port.

R3. THE web app SHALL import the package; no data-layer code is copied
    between the app and the package.

R4. THE package SHALL import and run in plain Node with React absent from
    the install (proof: packed tarball installed into an empty directory,
    `react` not resolvable, encrypt/decrypt and key derivation round trip).

R5. THE package SHALL provide a file-backed `KeyStorage`: directory 0700,
    records 0600 (also when a record file already existed with looser
    permissions), and it SHALL refuse to overwrite a record whose key
    material differs from what is stored, unless the caller explicitly
    replaces it.

R6. The web app on stash.cloistr.xyz SHALL keep working after deploy
    (existing unit suite green, production build succeeds, live page loads
    and its JS bundle is served).

Out of scope here: CLI verbs (step 4), RoleSigner (F1, cloistr-auth lane).
