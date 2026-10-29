Status: SIGNED (operator 2026-10-16, conscience-orch session)
Owner: conscience-orch (spec); cloistr-stash (Phase 1 build)

# Drive interop Phase 1 (Stash metadata): requirements

The signed requirements live in `/home/forgemaster/arbiter/conscience/specs/cloistr-drive-interop/requirements.md`, section **S** (S1 to S7). They are
not copied here, so there is one source of truth. Phase 1 builds S1 to S7:

- S1 hierarchy hidden; S2 file facts hidden; S3 no plaintext fingerprint; S4 a folder recipient
  lists that folder with one relay query; S5 key wraps name no file ids; S6 migration with
  verify-before-delete; S7 stated residue in the UI help.

Added by cloistr-orchestrator 2026-10-16 (binding for this build): the migration does not run for
real users until Space shows files through the Stash embed; Space never holds the Stash root key.
